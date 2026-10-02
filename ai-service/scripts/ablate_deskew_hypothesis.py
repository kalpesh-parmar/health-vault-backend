from __future__ import annotations

import hashlib
import json
import logging
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import cv2
import numpy as np

# Ensure ai-service root is in sys.path
AI_SERVICE_ROOT = Path(__file__).resolve().parent.parent
if str(AI_SERVICE_ROOT) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_ROOT))

from app.modules.ocr.paddle_engine import PaddleOcrEngine
from app.services.pipeline.preprocessing import deskew_image, preprocess_document_image

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("ablate_deskew")


def calculate_image_sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def estimate_skew_angle(img_bytes: bytes) -> float:
    """Estimate dominant skew angle using OpenCV minAreaRect without altering image."""
    try:
        nparr = np.frombuffer(img_bytes, np.uint8)
        img = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        if img is None:
            return 0.0
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if len(img.shape) == 3 else img
        thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV | cv2.THRESH_OTSU)[1]
        coords = np.column_stack(np.where(thresh > 0))
        if len(coords) < 50:
            return 0.0
        angle = cv2.minAreaRect(coords)[-1]
        if angle < -45.0:
            angle = -(90.0 + angle)
        elif angle > 45.0:
            angle = 90.0 - angle
        else:
            angle = -angle
        return round(float(angle), 2)
    except Exception as exc:
        logger.warning("Failed to estimate skew angle: %s", exc)
        return 0.0


def run_ablation() -> dict[str, Any]:
    # Locate fixtures
    ablation_dir = AI_SERVICE_ROOT / "tests" / "fixtures" / "golden_scanned" / "ablation"
    golden_docs_dir = AI_SERVICE_ROOT / "tests" / "fixtures" / "golden_docs"

    fixture_paths: list[Path] = []
    lab_1 = golden_docs_dir / "lab_1_.jpeg"
    if lab_1.exists():
        fixture_paths.append(lab_1)

    rotation_fixtures = sorted(ablation_dir.glob("ablation_rot_*.png"))
    fixture_paths.extend(rotation_fixtures)

    if not fixture_paths:
        raise FileNotFoundError(f"No ablation fixtures found in {ablation_dir} or {golden_docs_dir}")

    logger.info("Found %d ablation fixtures to evaluate", len(fixture_paths))

    modes = [
        "mode_a_bypass",
        "mode_b_opencv_deskew",
        "mode_c_paddle_cls",
    ]

    all_results: list[dict[str, Any]] = []

    for mode in modes:
        logger.info("=== Initializing Engine for %s ===", mode)
        PaddleOcrEngine.reset_instance()

        if mode == "mode_a_bypass":
            engine = PaddleOcrEngine.get_instance(lang="en", bypass_orientation=True)
        elif mode == "mode_b_opencv_deskew":
            engine = PaddleOcrEngine.get_instance(lang="en", bypass_orientation=True)
        elif mode == "mode_c_paddle_cls":
            engine = PaddleOcrEngine.get_instance(lang="en", bypass_orientation=False, use_angle_cls=True)
        else:
            raise ValueError(f"Unknown mode: {mode}")

        for fixture_path in fixture_paths:
            img_bytes = fixture_path.read_bytes()
            estimated_angle = estimate_skew_angle(img_bytes)
            file_sha256 = calculate_image_sha256(img_bytes)

            preprocess_ms = 0.0
            input_bytes = img_bytes

            if mode == "mode_b_opencv_deskew":
                t_prep_start = time.perf_counter()
                input_bytes = preprocess_document_image(
                    img_bytes,
                    deskew=True,
                    remove_shadows=False,
                    binarize=False,
                )
                preprocess_ms = round((time.perf_counter() - t_prep_start) * 1000, 2)

            t_ocr_start = time.perf_counter()
            ocr_result = engine.extract_text_from_bytes(input_bytes)
            ocr_inference_ms = round((time.perf_counter() - t_ocr_start) * 1000, 2)
            total_ms = round(preprocess_ms + ocr_inference_ms, 2)

            lines = ocr_result.get("lines") or []
            line_count = int(ocr_result.get("line_count", len(lines)))
            char_count = sum(len(str(line.get("text", ""))) for line in lines)
            mean_conf = float(ocr_result.get("mean_confidence") or 0.0)

            # Strict Zero PHI: DO NOT store or log line texts
            record = {
                "fixture": fixture_path.name,
                "mode": mode,
                "estimated_angle_deg": estimated_angle,
                "preprocess_ms": preprocess_ms,
                "ocr_inference_ms": ocr_inference_ms,
                "total_ms": total_ms,
                "line_count": line_count,
                "char_count": char_count,
                "mean_confidence": round(mean_conf, 4),
                "sha256": file_sha256,
            }
            all_results.append(record)
            logger.info(
                "[%s] %s -> lines=%d chars=%d conf=%.3f prep=%.1fms infer=%.1fms total=%.1fms",
                mode,
                fixture_path.name,
                line_count,
                char_count,
                mean_conf,
                preprocess_ms,
                ocr_inference_ms,
                total_ms,
            )

    # Clean up engine pool
    PaddleOcrEngine.reset_instance()

    # Aggregate summary by mode
    summary_by_mode: dict[str, Any] = {}
    for mode in modes:
        mode_records = [r for r in all_results if r["mode"] == mode]
        if mode_records:
            summary_by_mode[mode] = {
                "count": len(mode_records),
                "mean_preprocess_ms": round(float(np.mean([r["preprocess_ms"] for r in mode_records])), 2),
                "mean_ocr_inference_ms": round(float(np.mean([r["ocr_inference_ms"] for r in mode_records])), 2),
                "mean_total_ms": round(float(np.mean([r["total_ms"] for r in mode_records])), 2),
                "mean_line_count": round(float(np.mean([r["line_count"] for r in mode_records])), 2),
                "mean_char_count": round(float(np.mean([r["char_count"] for r in mode_records])), 2),
                "mean_confidence": round(float(np.mean([r["mean_confidence"] for r in mode_records])), 4),
            }

    # Locate workspace root containing .planning
    current = Path(__file__).resolve().parent
    workspace_root = None
    for parent in [current] + list(current.parents):
        if (parent / ".planning").exists():
            workspace_root = parent
            break
    if workspace_root is None:
        workspace_root = Path(__file__).resolve().parents[2]

    output_path = workspace_root / ".planning" / "benchmarks" / "phase3_deskew_ablation.json"
    output_path.parent.mkdir(parents=True, exist_ok=True)

    report_payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "modes_evaluated": modes,
        "fixtures_count": len(fixture_paths),
        "summary_by_mode": summary_by_mode,
        "results": all_results,
    }

    output_path.write_text(json.dumps(report_payload, indent=2), encoding="utf-8")
    logger.info("Ablation report saved successfully to %s", output_path)
    return report_payload


if __name__ == "__main__":
    run_ablation()
