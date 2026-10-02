from __future__ import annotations

import json
import unittest
from pathlib import Path

import cv2
import numpy as np

from app.services.pipeline.preprocessing import (
    adaptive_binarize,
    deskew_image,
    enhance_contrast_and_remove_shadows,
    preprocess_document_image,
)


def _create_synthetic_text_image(angle_deg: float = 0.0) -> np.ndarray:
    """Create a synthetic document image with clean horizontal lines of text, optionally rotated."""
    img = np.ones((800, 600), dtype=np.uint8) * 255

    # Draw several horizontal lines simulating printed text
    for y in range(100, 700, 40):
        cv2.putText(
            img,
            "HEALTH VAULT CLINICAL LABORATORY REPORT SAMPLE TEXT LINE",
            (50, y),
            cv2.FONT_HERSHEY_SIMPLEX,
            0.5,
            0,
            1,
            cv2.LINE_AA,
        )

    if abs(angle_deg) > 0.01:
        (h, w) = img.shape[:2]
        center = (w // 2, h // 2)
        m = cv2.getRotationMatrix2D(center, angle_deg, 1.0)
        img = cv2.warpAffine(img, m, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_CONSTANT, borderValue=255)

    return img


def _measure_skew(img: np.ndarray) -> float:
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
    return float(angle)


class TestDeskewAblation(unittest.TestCase):
    """Unit test suite for OpenCV deskewing, preprocessing, and ablation benchmarks."""

    def test_upright_document_early_exit(self) -> None:
        """Upright image with angle < 0.5 deg should return original array directly."""
        img = _create_synthetic_text_image(angle_deg=0.0)
        skew_before = _measure_skew(img)
        self.assertLess(abs(skew_before), 0.5)

        deskewed = deskew_image(img, max_angle=45.0)
        # Verify content was unchanged
        np.testing.assert_array_equal(deskewed, img)

    def test_skewed_document_rotation_correction(self) -> None:
        """Document with 8 degree skew should be rotated back towards horizontal."""
        target_skew = 8.0
        img = _create_synthetic_text_image(angle_deg=target_skew)
        measured_before = _measure_skew(img)
        self.assertAlmostEqual(abs(measured_before), target_skew, delta=2.0)

        deskewed = deskew_image(img, max_angle=45.0)
        measured_after = _measure_skew(deskewed)

        # Skew should be corrected to near horizontal (< 1.5 degrees residual)
        self.assertLess(abs(measured_after), 1.5, f"Residual skew was too high: {measured_after}")

    def test_excessive_skew_boundary_protection(self) -> None:
        """Document with angle exceeding max_angle should not be rotated."""
        # 15 degrees rotation is beyond a max_angle threshold of 10.0
        img = _create_synthetic_text_image(angle_deg=15.0)
        deskewed = deskew_image(img, max_angle=10.0)
        np.testing.assert_array_equal(deskewed, img)

    def test_preprocess_document_image_modes(self) -> None:
        """Test preprocessing byte pipeline with various mode flags."""
        img = _create_synthetic_text_image(angle_deg=5.0)
        _, enc = cv2.imencode(".png", img)
        raw_bytes = enc.tobytes()

        # Deskew only
        out_deskew = preprocess_document_image(raw_bytes, deskew=True, remove_shadows=False, binarize=False)
        self.assertGreater(len(out_deskew), 0)
        nparr = np.frombuffer(out_deskew, np.uint8)
        decoded = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
        self.assertIsNotNone(decoded)

        # Deskew + Shadow removal
        out_shadows = preprocess_document_image(raw_bytes, deskew=True, remove_shadows=True, binarize=False)
        self.assertGreater(len(out_shadows), 0)

        # Graceful handling of corrupted/empty bytes
        self.assertEqual(preprocess_document_image(b""), b"")
        self.assertEqual(preprocess_document_image(b"not_an_image"), b"not_an_image")

    def test_zero_phi_in_benchmark_results(self) -> None:
        """Assert that if phase3_deskew_ablation.json exists, it strictly contains zero PHI."""
        benchmark_file = Path(__file__).resolve().parents[4] / ".planning" / "benchmarks" / "phase3_deskew_ablation.json"
        if not benchmark_file.exists():
            self.skipTest(f"Benchmark file not generated yet at {benchmark_file}")

        data = json.loads(benchmark_file.read_text(encoding="utf-8"))
        self.assertIn("modes_evaluated", data)
        self.assertIn("summary_by_mode", data)
        self.assertIn("results", data)

        prohibited_keys = {"text", "full_text", "lines", "patient", "extracted_text", "words"}
        for record in data.get("results", []):
            record_keys = set(record.keys())
            overlap = record_keys & prohibited_keys
            self.assertEqual(len(overlap), 0, f"Prohibited text/PHI keys found in benchmark record: {overlap}")
            self.assertIn("fixture", record)
            self.assertIn("mode", record)
            self.assertIn("line_count", record)
            self.assertIn("char_count", record)
            self.assertIn("mean_confidence", record)


if __name__ == "__main__":
    unittest.main()
