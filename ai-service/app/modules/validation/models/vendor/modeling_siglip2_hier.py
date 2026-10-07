# Copyright 2025 Eka Care and The HuggingFace Team. All rights reserved.
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
#     http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.
"""Hierarchical SigLIP2 document classifier as a self-contained local model.

One pooled embedding of the (frozen) SigLIP2 tower drives several heads:
    image -> SigLIP2 vision tower -> pooled [d]
        flat L2 head (on the RAW pooled feature) -> 27-way leaf, L1 inferred
        standardize (mu/sd) -> z, then:
            L1 head                  -> 5-way document group
            leaf L2 head[L1]         -> leaf within an L1 group
            medical / handwritten    -> sigmoid (P positive)
            quality                  -> sigmoid (P good) reported as p_good & 1-100 score
"""
from __future__ import annotations

import os
from typing import Optional

import torch
import torch.nn as nn
from transformers import PreTrainedModel, AutoImageProcessor
from safetensors.torch import load_file

from app.modules.validation.models.vendor.configuration_siglip2_hier import Siglip2HierConfig


class _MLPHead(nn.Module):
    """Linear -> GELU -> Dropout -> Linear. Must match the training-time head."""

    def __init__(self, d_in: int, n_out: int, hidden: int = 512, dropout: float = 0.0):
        super().__init__()
        self.net = nn.Sequential(
            nn.Linear(d_in, hidden), nn.GELU(), nn.Dropout(dropout), nn.Linear(hidden, n_out)
        )

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


class Siglip2HierForDocClassification(PreTrainedModel):
    config_class = Siglip2HierConfig
    main_input_name = "pixel_values"
    _tied_weights_keys = []
    _keys_to_ignore_on_load_missing = []

    @classmethod
    def from_pretrained(cls, pretrained_model_name_or_path: str, *model_args, **kwargs):
        """Load weights from local files with backward-compatible state-dict mapping."""
        kwargs.pop("output_loading_info", None)
        config = kwargs.pop("config", None)
        if config is None:
            config = Siglip2HierConfig.from_pretrained(pretrained_model_name_or_path, **kwargs)

        model = cls(config, *model_args)

        weights_path = os.path.join(pretrained_model_name_or_path, "model.safetensors")
        if os.path.exists(weights_path):
            state_dict = load_file(weights_path)
        else:
            bin_path = os.path.join(pretrained_model_name_or_path, "pytorch_model.bin")
            state_dict = torch.load(bin_path, map_location="cpu")

        # In transformers < 5.6.0, Siglip2VisionModel nests layers under self.vision_model.
        # In transformers >= 5.6.0, the intermediate vision_model prefix is removed.
        has_vm = hasattr(model, "vision") and hasattr(model.vision, "vision_model")
        adapted: dict[str, torch.Tensor] = {}
        for k, v in state_dict.items():
            if has_vm and k.startswith("vision.") and not k.startswith("vision.vision_model."):
                adapted[k.replace("vision.", "vision.vision_model.", 1)] = v
            elif not has_vm and k.startswith("vision.vision_model."):
                adapted[k.replace("vision.vision_model.", "vision.", 1)] = v
            else:
                adapted[k] = v

        missing, _ = model.load_state_dict(adapted, strict=False)
        missing_v = [k for k in missing if k.startswith("vision.")]
        if missing_v:
            raise RuntimeError(f"Vision tower missing keys: {missing_v[:5]}")

        # Enforce float32 on CPU to avoid slow bfloat16 emulation
        model = model.to(torch.float32).eval()

        try:
            proc = AutoImageProcessor.from_pretrained(pretrained_model_name_or_path, **kwargs)
            model.set_processor(proc)
        except Exception:
            pass

        return model

    def __init__(self, config: Siglip2HierConfig):
        super().__init__(config)
        from transformers import Siglip2VisionConfig, Siglip2VisionModel

        vc = config.vision_config
        if isinstance(vc, dict):
            vc = Siglip2VisionConfig(**vc)
        self.vision = Siglip2VisionModel(vc) if vc is not None else None

        d, hid = config.hidden_size, config.head_hidden
        sig = set(config.sigmoid_heads)
        self.l1_head = _MLPHead(d, len(config.l1_classes), hid)
        self.leaf_heads = nn.ModuleList(
            [_MLPHead(d, len(config.l2_by_l1[l1]), hid) for l1 in config.l1_classes]
        )
        self.flat_head = nn.Linear(d, len(config.flat_l2_classes)) if config.flat_l2_classes else None
        self.med_head = _MLPHead(d, 1 if "med" in sig else len(config.med_classes), hid)
        self.hand_head = _MLPHead(d, 1 if "hand" in sig else len(config.hand_classes), hid)
        self.qual_head = _MLPHead(d, 1 if "qual" in sig else len(config.qual_classes), hid)

        self.register_buffer("mu", torch.zeros(1, d, dtype=torch.float32))
        self.register_buffer("sd", torch.ones(1, d, dtype=torch.float32))

        self._processor = None
        self.post_init()

    def set_processor(self, processor):
        self._processor = processor
        return self

    def _get_processor(self):
        if self._processor is None:
            src = self.config._name_or_path or self.name_or_path
            if not src:
                raise RuntimeError("No image processor available.")
            proc = AutoImageProcessor.from_pretrained(src)
            proc.max_num_patches = self.config.max_num_patches
            self._processor = proc
        return self._processor

    @property
    def _compute_dtype(self) -> torch.dtype:
        dt = self.dtype
        return dt if dt.is_floating_point else torch.float32

    @torch.no_grad()
    def _embed_raw(self, image) -> torch.Tensor:
        """Image -> RAW pooled embedding [1, d] (fp32). One vision forward."""
        from PIL import Image

        if isinstance(image, (str, os.PathLike)):
            image = Image.open(image)
        elif hasattr(image, "read"):
            image = Image.open(image)
        image = image.convert("RGB")

        proc = self._get_processor()
        enc = proc(images=[image], return_tensors="pt")
        device, cdtype = self.device, self._compute_dtype
        enc = {
            k: (v.to(device=device, dtype=cdtype) if torch.is_floating_point(v) else v.to(device))
            for k, v in enc.items()
        }
        return self.vision(**enc).pooler_output.float()

    def _standardize(self, feat: torch.Tensor) -> torch.Tensor:
        return (feat - self.mu.float()) / self.sd.float()

    def _softmax_probs(self, head: nn.Module, x: torch.Tensor) -> torch.Tensor:
        logits = head(x.to(self._compute_dtype))
        return torch.softmax(logits.float()[0], dim=-1)

    def _sigmoid_pos(self, head: nn.Module, z: torch.Tensor) -> float:
        logit = head(z.to(self._compute_dtype)).float().reshape(-1)[0]
        return float(torch.sigmoid(logit))

    def _top(self, probs: torch.Tensor, classes: list[str], top_k: Optional[int]):
        if top_k and top_k > 1:
            k = min(top_k, probs.numel())
            vals, idx = torch.topk(probs, k)
            return [{"value": classes[int(i)], "confidence": round(float(v), 4)} for v, i in zip(vals, idx)]
        i = int(probs.argmax())
        return {"value": classes[i], "confidence": round(float(probs[i]), 4)}

    def _flat_l2(self, raw: torch.Tensor, top_k: Optional[int]) -> dict:
        probs = self._softmax_probs(self.flat_head, raw)
        disp = self.config.l2_display
        res = self._top(probs, self.config.flat_l2_classes, top_k)
        if isinstance(res, list):
            for r in res:
                r["key"] = r["value"]
                r["value"] = disp.get(r["key"], r["key"])
            top_key = res[0]["key"]
            l2 = {"source": "flat", "candidates": res}
        else:
            top_key = res["value"]
            l2 = {"source": "flat", "key": top_key, "value": disp.get(top_key, top_key), "confidence": res["confidence"]}
        l1_name = self.config.flat_l2_to_l1.get(top_key)
        return {"l2": l2, "l1": {"value": l1_name, "source": "inferred_from_flat_l2"}}

    def _binary(self, name: str, z: torch.Tensor, head: nn.Module, classes: list[str]) -> dict:
        if name in self.config.sigmoid_heads:
            p = self._sigmoid_pos(head, z)
        else:
            probs = self._softmax_probs(head, z)
            p = float(probs[-1])
        pos, neg = classes[1], classes[0]
        is_pos = p >= 0.5
        return {
            "value": pos if is_pos else neg,
            "confidence": round(p if is_pos else 1 - p, 4),
            "p_positive": round(p, 4),
        }

    def _quality(self, z: torch.Tensor) -> dict:
        p = self._sigmoid_pos(self.qual_head, z)
        if self.config.quality_score_label != self.config.qual_classes[1]:
            p = 1.0 - p
        lo, hi = self.config.quality_score_min, self.config.quality_score_max
        score = int(round(lo + p * (hi - lo)))
        return {"score": score, "p_good": round(p, 4)}

    @torch.no_grad()
    def classify(
        self,
        image,
        scope: Optional[str] = None,
        l1: Optional[str] = None,
        medical: bool = True,
        quality: bool = True,
        handwritten: bool = True,
        top_k: Optional[int] = None,
    ) -> dict:
        scope = (scope or self.config.default_scope).lower()
        raw = self._embed_raw(image)
        z = self._standardize(raw)
        out: dict = {}

        if scope == "flat":
            out.update(self._flat_l2(raw, top_k))
        elif scope == "l1":
            out["l1"] = {**self._top(self._softmax_probs(self.l1_head, z), self.config.l1_classes, top_k), "source": "l1_head"}

        if medical:
            out["medical"] = self._binary("med", z, self.med_head, self.config.med_classes)
        if handwritten:
            out["handwritten"] = self._binary("hand", z, self.hand_head, self.config.hand_classes)
        if quality:
            out["quality"] = self._quality(z)
        return out
