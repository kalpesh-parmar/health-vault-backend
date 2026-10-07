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
"""Config for the hierarchical SigLIP2 document classifier.

Self-contained on purpose: every piece of taxonomy/metadata needed at inference
(L1 groups, the L2 leaves under each L1, the flat-L2 label space, the binary/quality
class orders, and the human-readable display names) is stored on the config, so the
published model repo does not depend on the parrotlet package.

Two L2 paths are shipped:
  * a **flat** 27-way L2 classifier (the backbone's own end-to-end head, run on the
    RAW pooled feature) — this is the DEFAULT path; L1 is *inferred* from the flat
    prediction via ``flat_l2_to_l1``.
  * per-L1 **leaf** L2 heads (run on the standardized embedding) — used when the
    caller fixes the L1 group, or asks for ``scope="hierarchical"``.

The medical / handwritten heads are single-logit **sigmoid** heads; ``*_classes`` is
ordered ``[negative, positive]`` and the sigmoid value is P(positive). The ``quality``
head is also a sigmoid, but is reported **only** as a single continuous ``score`` in
``[quality_score_min, quality_score_max]`` (default 1–100) — no poor/good label —
where ``score = round(min + P(good) * (max - min))``.
"""
from __future__ import annotations

from typing import Dict, List, Optional

from transformers import PretrainedConfig


class Siglip2HierConfig(PretrainedConfig):
    model_type = "siglip2_hier_doc"

    def __init__(
        self,
        base_model_id: str = "google/siglip2-base-patch16-naflex",
        vision_config: Optional[dict] = None,
        hidden_size: int = 768,
        head_hidden: int = 512,
        max_num_patches: int = 1024,
        l1_classes: Optional[List[str]] = None,
        l2_by_l1: Optional[Dict[str, List[str]]] = None,
        flat_l2_classes: Optional[List[str]] = None,
        flat_l2_to_l1: Optional[Dict[str, str]] = None,
        med_classes: Optional[List[str]] = None,
        hand_classes: Optional[List[str]] = None,
        qual_classes: Optional[List[str]] = None,
        sigmoid_heads: Optional[List[str]] = None,
        quality_score_label: str = "good",
        quality_score_min: int = 1,
        quality_score_max: int = 100,
        default_scope: str = "flat",
        l2_display: Optional[Dict[str, str]] = None,
        **kwargs,
    ):
        super().__init__(**kwargs)
        self.base_model_id = base_model_id
        self.vision_config = vision_config
        self.hidden_size = hidden_size
        self.head_hidden = head_hidden
        self.max_num_patches = max_num_patches
        # Taxonomy. l1_classes is the ordered L1 label space; l2_by_l1 maps each L1
        # to its ordered list of leaf L2 keys (the per-L1 leaf-head output space).
        self.l1_classes = list(l1_classes or [])
        self.l2_by_l1 = {k: list(v) for k, v in (l2_by_l1 or {}).items()}
        # Flat 27-way L2 head label space + key -> L1 group (for inferring L1 from
        # the flat prediction in the default scope).
        self.flat_l2_classes = list(flat_l2_classes or [])
        self.flat_l2_to_l1 = dict(flat_l2_to_l1 or {})
        # Binary heads: ordered [negative, positive]; sigmoid value is P(positive).
        self.med_classes = list(med_classes or ["no", "yes"])
        self.hand_classes = list(hand_classes or ["no", "yes"])
        self.qual_classes = list(qual_classes or ["poor", "good"])
        # Names of the heads that are single-logit sigmoid (vs softmax).
        self.sigmoid_heads = list(sigmoid_heads or ["med", "hand", "qual"])
        # The quality class whose sigmoid probability is reported as the score.
        self.quality_score_label = quality_score_label
        # quality is reported as a single number in [min, max] (no poor/good label):
        # score = round(min + P(good) * (max - min)).
        self.quality_score_min = int(quality_score_min)
        self.quality_score_max = int(quality_score_max)
        # Default L2 path: "flat" (flat head + inferred L1), "l1" (L1 head only),
        # or "hierarchical" (L1 head -> leaf head).
        self.default_scope = default_scope
        # Optional pretty names for L2 keys (e.g. "x_ray" -> "X-ray").
        self.l2_display = dict(l2_display or {})
