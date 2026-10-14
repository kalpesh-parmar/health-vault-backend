"""Lightweight Medical Document Classifier Module.

Wraps ekacare/med-doc-classifier with defensive system guards:
- Local CPU inference with torch.set_num_threads(2) and float32
- Image.MAX_IMAGE_PIXELS guard against decompression bomb DOS attacks
- Deterministic blank page detector (< 2ms)
- Threadpool execution to keep the FastAPI async event loop unblocked
- Quality head binary probability P(good) extraction
"""
from __future__ import annotations

import logging
import os
import threading
import time
from typing import Any, Optional

import numpy as np
import torch
from PIL import Image
from starlette.concurrency import run_in_threadpool

from app.modules.validation.models.vendor.modeling_siglip2_hier import Siglip2HierForDocClassification

logger = logging.getLogger(__name__)

# System guard: prevent decompression bomb denial-of-service
Image.MAX_IMAGE_PIXELS = 50_000_000


class ClassifierUnavailableError(Exception):
    """Raised when the local classifier model is missing or cannot be initialized."""


def is_blank_page(image: Image.Image) -> bool:
    """Fast deterministic check to detect blank/empty pages (< 15ms).

    Uses grayscale pixel intensity standard deviation and white pixel percentage.
    """
    try:
        from PIL import ImageStat

        gray = image.convert("L")
        stat = ImageStat.Stat(gray)
        std_dev = float(stat.stddev[0])

        # Standard deviation check: completely uniform page has near-zero variance
        if std_dev < 3.0:
            return True

        # Check for essentially uniform page (e.g. slight scanner dust or faint uniform noise)
        # Must have low variance (< 5.0) AND > 99.8% pixels near white (> 250) or dark (< 10)
        if std_dev < 5.0:
            hist = gray.histogram()
            total_pixels = sum(hist)
            if total_pixels > 0:
                white_pixels = sum(hist[250:])
                black_pixels = sum(hist[:10])
                if (white_pixels / total_pixels) > 0.998 or (black_pixels / total_pixels) > 0.998:
                    return True

        return False
    except Exception as e:
        logger.warning("Blank page check encountered error, defaulting to non-blank: %s", e)
        return False


class MedicalDocumentClassifier:
    """Thread-safe singleton wrapper for local CPU document classifier inference."""

    _instance: Optional[MedicalDocumentClassifier] = None
    _lock: threading.Lock = threading.Lock()

    def __init__(self, model_path: str = "models/med-doc-classifier") -> None:
        self.model_path = model_path
        self.model: Optional[Siglip2HierForDocClassification] = None
        self._is_ready: bool = False
        self._load_lock: threading.Lock = threading.Lock()

    @classmethod
    def get_instance(cls, model_path: str = "models/med-doc-classifier") -> MedicalDocumentClassifier:
        with cls._lock:
            if cls._instance is None:
                cls._instance = cls(model_path=model_path)
            return cls._instance

    @classmethod
    def reset_instance(cls) -> None:
        """Reset singleton (useful for test isolation)."""
        with cls._lock:
            cls._instance = None

    def is_ready(self) -> bool:
        return self._is_ready and self.model is not None

    def load(self, model_path: Optional[str] = None) -> None:
        """Load model weights and image processor onto CPU."""
        with self._load_lock:
            if self._is_ready and self.model is not None:
                return

            resolved_path = model_path or self.model_path

            # Check if model files exist locally
            weights_file = os.path.join(resolved_path, "model.safetensors")
            config_file = os.path.join(resolved_path, "config.json")
            if not os.path.exists(weights_file) or not os.path.exists(config_file):
                logger.warning(
                    "Classifier model weights or config missing at '%s'. Validation will return 503.",
                    resolved_path,
                )
                self._is_ready = False
                self.model = None
                raise ClassifierUnavailableError(
                    f"Classifier model missing at '{resolved_path}'. model.safetensors or config.json not found."
                )

            try:
                # Force 2 CPU threads to avoid CPU starvation with OCR worker pool
                torch.set_num_threads(2)
                logger.info("Loading local medical document classifier from '%s' on CPU...", resolved_path)
                self.model = Siglip2HierForDocClassification.from_pretrained(
                    resolved_path, local_files_only=True
                )
                self.model = self.model.to(torch.float32).eval()
                self._is_ready = True
                logger.info("Medical document classifier loaded successfully on CPU.")
            except Exception as exc:
                self._is_ready = False
                self.model = None
                logger.error("Failed to load classifier model from '%s': %s", resolved_path, exc, exc_info=True)
                raise ClassifierUnavailableError(f"Failed to load classifier model: {exc}") from exc

    def warmup(self) -> None:
        """Execute a synthetic 1x1 image inference to warm up PyTorch runtime."""
        if not self.is_ready():
            return
        try:
            synthetic_img = Image.new("RGB", (16, 16), color=(255, 255, 255))
            self.classify_image_sync(synthetic_img)
            logger.info("Medical document classifier warmup completed.")
        except Exception as exc:
            logger.warning("Classifier warmup failed: %s", exc)

    def classify_image_sync(self, image: Image.Image) -> dict[str, Any]:
        """Synchronous CPU inference for one PIL image."""
        if not self.is_ready() or self.model is None:
            raise ClassifierUnavailableError("Classifier model is not loaded or unavailable.")

        # Ensure decompression bomb guard is active
        Image.MAX_IMAGE_PIXELS = 50_000_000

        # Check for deterministic blank page
        if is_blank_page(image):
            return {
                "is_blank": True,
                "label": "BLANK",
                "p_medical": 0.0,
                "medical_value": "non_medical",
                "l2_key": "blank",
                "l2_value": "Blank Page",
                "p_good": 0.0,
                "handwritten_value": "printed",
            }

        # Run forward inference
        t_model_start = time.perf_counter()
        res = self.model.classify(image)
        t_model_elapsed = (time.perf_counter() - t_model_start) * 1000
        print(f"    [PYTHON TIMING] self.model.classify(image) CPU forward pass took {t_model_elapsed:.2f}ms", flush=True)

        med_info = res.get("medical", {})
        p_medical = float(med_info.get("p_positive", 0.0))
        med_value = str(med_info.get("value", "non_medical"))

        l2_info = res.get("l2", {})
        l2_key = str(l2_info.get("key", "other_document"))
        l2_value = str(l2_info.get("value", "Other Document"))

        qual_info = res.get("quality", {})
        # Use binary quality probability P(good), not 1-100 score
        p_good = float(qual_info.get("p_good", 1.0))

        hand_info = res.get("handwritten", {})
        hand_value = str(hand_info.get("value", "printed"))

        return {
            "is_blank": False,
            "label": "PROCESSED",
            "p_medical": p_medical,
            "medical_value": med_value,
            "l2_key": l2_key,
            "l2_value": l2_value,
            "p_good": p_good,
            "handwritten_value": hand_value,
        }

    async def classify_image(self, image: Image.Image) -> dict[str, Any]:
        """Run classification in Starlette threadpool to avoid blocking event loop."""
        return await run_in_threadpool(self.classify_image_sync, image)
