from __future__ import annotations

from dataclasses import dataclass
import io
import logging
from typing import Any

import cv2
import numpy as np
from PIL import Image

logger = logging.getLogger(__name__)


@dataclass
class FilterStageVerdict:
    passed: bool
    stage_rejected: str | None = None
    reason: str = ""
    asset_type: str | None = None
    confidence: float = 0.0


def compute_dhash(image: Image.Image | np.ndarray, hash_size: int = 8) -> str:
    """Computes a 64-bit difference hash (dHash) for perceptual image comparison."""
    if isinstance(image, Image.Image):
        gray = image.convert("L").resize((hash_size + 1, hash_size), Image.Resampling.BILINEAR)
        arr = np.array(gray, dtype=np.int32)
    elif isinstance(image, np.ndarray):
        if image.ndim == 3:
            gray_cv = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY if image.shape[2] == 3 else cv2.COLOR_BGRA2GRAY)
        else:
            gray_cv = image
        resized = cv2.resize(gray_cv, (hash_size + 1, hash_size), interpolation=cv2.INTER_LINEAR)
        arr = resized.astype(np.int32)
    else:
        return ""

    diff = arr[:, 1:] > arr[:, :-1]
    # Pack boolean 8x8 into 64-bit integer
    hash_val = 0
    for bit in diff.flatten():
        hash_val = (hash_val << 1) | int(bit)
    return f"{hash_val:016x}"


def hamming_distance(hash1: str, hash2: str) -> int:
    """Computes Hamming distance between two 16-hex-character dHash strings."""
    try:
        val1 = int(hash1, 16)
        val2 = int(hash2, 16)
        return bin(val1 ^ val2).count("1")
    except Exception:
        return 64


class VisualAssetFilter:
    """5-stage visual asset filter to prevent false visual asset extraction:
    Stage 1: Page Area Cap (reject > 70% of page area)
    Stage 2: Margin Band Exclusion (reject header top 12% / footer bottom 8%)
    Stage 3: Minimum Area Threshold (reject < 1.5% of page area or < 60x60)
    Stage 4: Perceptual Hash Repetition Filter (drop recurring >= 60% of pages)
    Stage 5: Positive Rule & Feature Heuristic Classifier (ECG, radiology, charts vs document text)
    """

    def __init__(
        self,
        max_page_area_ratio: float = 0.70,
        min_page_area_ratio: float = 0.015,
        top_margin_ratio: float = 0.12,
        bottom_margin_ratio: float = 0.08,
        repetition_threshold: float = 0.60,
    ) -> None:
        self.max_page_area_ratio = max_page_area_ratio
        self.min_page_area_ratio = min_page_area_ratio
        self.top_margin_ratio = top_margin_ratio
        self.bottom_margin_ratio = bottom_margin_ratio
        self.repetition_threshold = repetition_threshold

    def check_page_area_cap(
        self, crop_w: int, crop_h: int, page_w: int, page_h: int
    ) -> tuple[bool, str]:
        """Stage 1: Reject candidate crops occupying > 70% of total page area."""
        page_area = max(page_w * page_h, 1)
        crop_area = crop_w * crop_h
        ratio = crop_area / page_area
        if ratio > self.max_page_area_ratio:
            return False, f"PAGE_AREA_CAP_EXCEEDED (area_ratio={ratio:.3f} > {self.max_page_area_ratio})"
        return True, ""

    def check_margin_band_exclusion(
        self, ymin: int, ymax: int, page_h: int
    ) -> tuple[bool, str]:
        """Stage 2: Reject candidates residing entirely in header (top 12%) or footer (bottom 8%)."""
        if page_h <= 0:
            return True, ""

        top_limit = int(page_h * self.top_margin_ratio)
        bottom_limit = int(page_h * (1.0 - self.bottom_margin_ratio))

        # Completely within top margin
        if ymax <= top_limit:
            return False, f"HEADER_MARGIN_EXCLUDED (ymax={ymax} <= top_band={top_limit})"

        # Completely within bottom margin
        if ymin >= bottom_limit:
            return False, f"FOOTER_MARGIN_EXCLUDED (ymin={ymin} >= bottom_band={bottom_limit})"

        return True, ""

    def check_minimum_area_threshold(
        self, crop_w: int, crop_h: int, page_w: int, page_h: int
    ) -> tuple[bool, str]:
        """Stage 3: Reject small icons, bullets, divider lines (< 1.5% page area or < 60x60)."""
        if crop_w < 60 or crop_h < 60:
            return False, f"DIMENSIONS_TOO_SMALL (w={crop_w}, h={crop_h} < 60)"

        page_area = max(page_w * page_h, 1)
        crop_area = crop_w * crop_h
        ratio = crop_area / page_area
        if ratio < self.min_page_area_ratio:
            return False, f"BELOW_MIN_AREA_THRESHOLD (area_ratio={ratio:.4f} < {self.min_page_area_ratio})"

        return True, ""

    def classify_clinical_features(
        self, image: Image.Image | np.ndarray
    ) -> tuple[bool, str | None, float, str]:
        """Stage 5: Rule & feature heuristic classifier for clinical visuals.
        Distinguishes ECG strips, radiology scans, and clinical trend charts from document text scans.
        """
        if isinstance(image, Image.Image):
            arr = np.array(image)
        elif isinstance(image, np.ndarray):
            arr = image
        else:
            return False, None, 0.0, "INVALID_IMAGE_TYPE"

        h, w = arr.shape[:2]
        if h < 20 or w < 20:
            return False, None, 0.0, "IMAGE_TOO_SMALL"

        if arr.ndim == 3:
            gray = cv2.cvtColor(arr, cv2.COLOR_RGB2GRAY if arr.shape[2] == 3 else cv2.COLOR_RGBA2GRAY)
        else:
            gray = arr

        aspect = w / max(h, 1)
        mean_intensity = float(np.mean(gray))
        std_intensity = float(np.std(gray))

        # Binarize via Otsu threshold
        _, thresh = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
        ink_pixel_ratio = float(np.count_nonzero(thresh)) / thresh.size
        white_bg_fraction = 1.0 - ink_pixel_ratio

        # ── Check 1: Document Text Rejection ──────────────────────────────────
        # Document text pages have bright white background (> 80%), low ink ratio (< 25%),
        # and predominantly character-sized contours distributed horizontally.
        if white_bg_fraction >= 0.78 and mean_intensity >= 200:
            contours, _ = cv2.findContours(thresh, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if len(contours) >= 15:
                # Many small disconnected glyph contours -> document text scan
                char_like_count = 0
                for c in contours:
                    cw, ch = cv2.boundingRect(c)[2:]
                    if 4 <= ch <= 120 and 4 <= cw <= 300:
                        char_like_count += 1
                if char_like_count / len(contours) > 0.60:
                    return False, None, 0.0, f"DOCUMENT_TEXT_EXCLUDED (char_contours={char_like_count}/{len(contours)})"

        # ── Check 2: ECG / Waveform Strip ─────────────────────────────────────
        # Wide aspect ratio (>= 3.0) with significant high-frequency signal content
        if aspect >= 2.8 and std_intensity >= 15.0 and h >= 50:
            # Check horizontal gradient energy vs vertical
            sobelx = cv2.Sobel(gray, cv2.CV_64F, 1, 0, ksize=3)
            sobely = cv2.Sobel(gray, cv2.CV_64F, 0, 1, ksize=3)
            grad_energy = float(np.mean(np.abs(sobelx)) + np.mean(np.abs(sobely)))
            if grad_energy >= 8.0:
                conf = min(0.98, 0.75 + (aspect / 10.0))
                return True, "ecg_waveform_strip", round(conf, 2), "ECG_WAVEFORM_HEURISTIC_MATCH"

        # ── Check 3: Radiology / Ultrasound / CT / MRI Scan ───────────────────
        # Continuous-tone grayscale images have wide intensity distribution (high std),
        # darker or variable background (mean < 210), and low Otsu background whiteness (< 75%).
        if std_intensity >= 32.0 and white_bg_fraction <= 0.75 and 15.0 <= mean_intensity <= 210.0:
            # Check for lack of dense text line patterns
            conf = min(0.95, 0.65 + (std_intensity / 100.0))
            return True, "radiology_scan", round(conf, 2), "RADIOLOGY_SCAN_HEURISTIC_MATCH"

        # ── Check 4: Clinical Trend Chart / Growth Graph ──────────────────────
        # Charts contain axes / grid line structures (detectable via morphological kernels)
        if 0.5 <= aspect <= 2.5 and std_intensity >= 20.0:
            horiz_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (max(w // 20, 15), 1))
            vert_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (1, max(h // 20, 15)))
            h_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, horiz_kernel)
            v_lines = cv2.morphologyEx(thresh, cv2.MORPH_OPEN, vert_kernel)
            line_density = (np.count_nonzero(h_lines) + np.count_nonzero(v_lines)) / thresh.size
            if line_density >= 0.005:
                return True, "clinical_chart", 0.88, "CLINICAL_CHART_HEURISTIC_MATCH"

        return False, None, 0.0, "NON_CLINICAL_IMAGE_EXCLUDED"

    def evaluate_candidate_crop(
        self,
        image: Image.Image | np.ndarray,
        bbox: list[int],
        page_w: int,
        page_h: int,
    ) -> FilterStageVerdict:
        """Evaluates a candidate crop through stages 1, 2, 3, and 5."""
        # bbox format: [ymin, xmin, ymax, xmax] or [x, y, w, h]
        if len(bbox) == 4:
            if bbox[2] > bbox[0] and bbox[3] > bbox[1]:  # [ymin, xmin, ymax, xmax]
                ymin, xmin, ymax, xmax = bbox
                crop_w = xmax - xmin
                crop_h = ymax - ymin
            else:  # [x, y, w, h]
                xmin, ymin, crop_w, crop_h = bbox
                ymax = ymin + crop_h
                xmax = xmin + crop_w
        else:
            if isinstance(image, Image.Image):
                crop_w, crop_h = image.size
            else:
                crop_h, crop_w = image.shape[:2]
            xmin, ymin, xmax, ymax = 0, 0, crop_w, crop_h

        # Stage 1: Page Area Cap
        p1, r1 = self.check_page_area_cap(crop_w, crop_h, page_w, page_h)
        if not p1:
            return FilterStageVerdict(passed=False, stage_rejected="STAGE_1_PAGE_AREA_CAP", reason=r1)

        # Stage 2: Margin Band Exclusion
        p2, r2 = self.check_margin_band_exclusion(ymin, ymax, page_h)
        if not p2:
            return FilterStageVerdict(passed=False, stage_rejected="STAGE_2_MARGIN_BAND", reason=r2)

        # Stage 3: Minimum Area Threshold
        p3, r3 = self.check_minimum_area_threshold(crop_w, crop_h, page_w, page_h)
        if not p3:
            return FilterStageVerdict(passed=False, stage_rejected="STAGE_3_MIN_AREA", reason=r3)

        # Stage 5: Positive Clinical Feature Heuristic
        p5, asset_type, conf, r5 = self.classify_clinical_features(image)
        if not p5:
            return FilterStageVerdict(passed=False, stage_rejected="STAGE_5_FEATURE_CLASSIFIER", reason=r5)

        return FilterStageVerdict(
            passed=True,
            stage_rejected=None,
            reason=r5,
            asset_type=asset_type,
            confidence=conf,
        )

    def filter_repetitive_crops(
        self, candidate_records: list[dict[str, Any]], total_pages: int
    ) -> list[dict[str, Any]]:
        """Stage 4: Drop visual crops appearing across >= 60% of pages in multi-page documents."""
        if total_pages <= 1 or not candidate_records:
            return candidate_records

        # Map each candidate to (hash, page)
        hash_to_pages: dict[str, set[int]] = {}
        candidate_hashes: list[str] = []

        for c in candidate_records:
            h_str = c.get("dhash") or ""
            if not h_str and "image_bytes" in c:
                try:
                    img = Image.open(io.BytesIO(c["image_bytes"]))
                    h_str = compute_dhash(img)
                    c["dhash"] = h_str
                except Exception:
                    h_str = ""

            candidate_hashes.append(h_str)
            if h_str:
                page_no = c.get("page", 1)
                # Find matching existing cluster within Hamming distance <= 4
                matched_key = None
                for existing_hash in hash_to_pages:
                    if hamming_distance(h_str, existing_hash) <= 4:
                        matched_key = existing_hash
                        break

                target_key = matched_key or h_str
                if target_key not in hash_to_pages:
                    hash_to_pages[target_key] = set()
                hash_to_pages[target_key].add(page_no)

        # Determine rejected clusters
        recurrent_keys: set[str] = set()
        for key_hash, pages in hash_to_pages.items():
            freq = len(pages) / total_pages
            if freq >= self.repetition_threshold:
                recurrent_keys.add(key_hash)
                logger.info("Dropping repetitive visual asset (dhash=%s, pages=%d/%d)", key_hash, len(pages), total_pages)

        # Retain only non-repetitive candidates
        filtered: list[dict[str, Any]] = []
        for c, h_str in zip(candidate_records, candidate_hashes):
            is_recurrent = False
            for r_key in recurrent_keys:
                if hamming_distance(h_str, r_key) <= 4:
                    is_recurrent = True
                    break
            if not is_recurrent:
                filtered.append(c)

        return filtered
