from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock

import cv2
import numpy as np
from PIL import Image
import pytest

from app.modules.vision.visual_asset_filter import (
    VisualAssetFilter,
    compute_dhash,
    hamming_distance,
)
from app.services.pipeline.graph_stage import GraphStageHandler


@pytest.fixture
def filter_instance() -> VisualAssetFilter:
    return VisualAssetFilter()


def test_stage1_page_area_cap_rejects_full_page(filter_instance: VisualAssetFilter):
    """Verify crop occupying > 70% of total page area is rejected."""
    # 800x1000 page area (800,000); 700x900 crop area (630,000 = 78.75%)
    passed, reason = filter_instance.check_page_area_cap(700, 900, 800, 1000)
    assert not passed
    assert "PAGE_AREA_CAP_EXCEEDED" in reason

    # 300x300 crop (90,000 = 11.25%) -> passes
    passed, reason = filter_instance.check_page_area_cap(300, 300, 800, 1000)
    assert passed
    assert reason == ""


def test_stage2_margin_band_rejects_header_and_footer(filter_instance: VisualAssetFilter):
    """Verify crops located in top 12% or bottom 8% margins are excluded."""
    page_h = 1000

    # Header region: ymax = 100 <= 120 (12%)
    passed_top, reason_top = filter_instance.check_margin_band_exclusion(ymin=10, ymax=100, page_h=page_h)
    assert not passed_top
    assert "HEADER_MARGIN_EXCLUDED" in reason_top

    # Footer region: ymin = 930 >= 920 (92%)
    passed_bottom, reason_bottom = filter_instance.check_margin_band_exclusion(ymin=930, ymax=980, page_h=page_h)
    assert not passed_bottom
    assert "FOOTER_MARGIN_EXCLUDED" in reason_bottom

    # Center body: ymin = 200, ymax = 500 -> passes
    passed_mid, reason_mid = filter_instance.check_margin_band_exclusion(ymin=200, ymax=500, page_h=page_h)
    assert passed_mid
    assert reason_mid == ""


def test_stage3_min_area_rejects_tiny_icons(filter_instance: VisualAssetFilter):
    """Verify tiny crops (< 1.5% page area or < 60x60) are rejected."""
    page_w, page_h = 1000, 1000

    # Too small dimensions: 40x40
    passed_dim, reason_dim = filter_instance.check_minimum_area_threshold(40, 40, page_w, page_h)
    assert not passed_dim
    assert "DIMENSIONS_TOO_SMALL" in reason_dim

    # Area ratio < 0.015: 70x70 = 4900 / 1,000,000 = 0.0049
    passed_ratio, reason_ratio = filter_instance.check_minimum_area_threshold(70, 70, page_w, page_h)
    assert not passed_ratio
    assert "BELOW_MIN_AREA_THRESHOLD" in reason_ratio

    # Normal crop: 200x200 = 40,000 = 4% -> passes
    passed_ok, reason_ok = filter_instance.check_minimum_area_threshold(200, 200, page_w, page_h)
    assert passed_ok
    assert reason_ok == ""


def test_stage4_repetition_filter_rejects_recurrent_logo(filter_instance: VisualAssetFilter):
    """Verify crops appearing on >= 60% of pages are dropped as repetitive letterheads/logos."""
    # Create synthetic logo image
    logo = np.zeros((80, 80, 3), dtype=np.uint8)
    cv2.circle(logo, (40, 40), 20, (255, 0, 0), -1)
    logo_hash = compute_dhash(logo)

    unique_img = np.zeros((80, 80, 3), dtype=np.uint8)
    cv2.rectangle(unique_img, (10, 10), (70, 70), (0, 255, 0), -1)
    unique_hash = compute_dhash(unique_img)

    # 3-page document: logo appears on page 1 and page 2 (2/3 = 66.7% >= 60%)
    candidates = [
        {"title": "Logo P1", "page": 1, "dhash": logo_hash},
        {"title": "Logo P2", "page": 2, "dhash": logo_hash},
        {"title": "Unique P3", "page": 3, "dhash": unique_hash},
    ]

    filtered = filter_instance.filter_repetitive_crops(candidates, total_pages=3)
    assert len(filtered) == 1
    assert filtered[0]["title"] == "Unique P3"


def test_stage5_text_document_scan_rejected(filter_instance: VisualAssetFilter):
    """Verify synthetic document text page is classified as DOCUMENT_TEXT and rejected."""
    # Create white canvas with black text lines
    img = np.full((500, 500, 3), 255, dtype=np.uint8)
    for y in range(40, 460, 30):
        cv2.putText(img, "Patient Prescription Line Text Sample 100mg", (30, y), cv2.FONT_HERSHEY_SIMPLEX, 0.45, (0, 0, 0), 1)

    passed, asset_type, conf, reason = filter_instance.classify_clinical_features(img)
    assert not passed
    assert "DOCUMENT_TEXT_EXCLUDED" in reason
    assert asset_type is None


def test_stage5_ecg_strip_accepted(filter_instance: VisualAssetFilter):
    """Verify synthetic ECG rhythm strip is recognized as ecg_waveform_strip."""
    # Create wide aspect ratio strip: 600 x 100 (aspect 6.0 >= 3.0)
    img = np.full((100, 600, 3), 245, dtype=np.uint8)
    # Draw repeating ECG waveform signal
    pts = []
    for x in range(0, 600, 2):
        phase = (x % 60)
        if 20 <= phase <= 30:
            y = 50 - int(35 * np.sin((phase - 20) / 10 * np.pi))
        elif 30 < phase <= 35:
            y = 50 + int(20 * np.sin((phase - 30) / 5 * np.pi))
        else:
            y = 50
        pts.append((x, y))
    for i in range(len(pts) - 1):
        cv2.line(img, pts[i], pts[i + 1], (0, 0, 180), 2)

    passed, asset_type, conf, reason = filter_instance.classify_clinical_features(img)
    assert passed
    assert asset_type == "ecg_waveform_strip"
    assert conf >= 0.75


def test_stage5_radiology_scan_accepted(filter_instance: VisualAssetFilter):
    """Verify continuous-tone radiology thumbnail (X-ray/ultrasound) is accepted."""
    # Create continuous-tone patch: low background whiteness, high std dev
    np.random.seed(42)
    img = np.random.normal(loc=95, scale=40, size=(250, 250, 3)).clip(0, 255).astype(np.uint8)
    cv2.circle(img, (125, 125), 60, (180, 180, 180), -1)
    img = cv2.GaussianBlur(img, (9, 9), 0)

    passed, asset_type, conf, reason = filter_instance.classify_clinical_features(img)
    assert passed
    assert asset_type == "radiology_scan"
    assert conf >= 0.65


@pytest.mark.asyncio
async def test_out05_lab1_yields_zero_assets():
    """Falsifiable Acceptance Test for OUT-05: lab_1_.jpeg yields exactly 0 visual assets."""
    golden_path = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert golden_path.is_file(), f"Golden doc fixture not found at {golden_path}"

    s3_mock = AsyncMock()
    handler = GraphStageHandler(s3_client=s3_mock)

    extracted = await handler.extract_graphs(
        file_path=golden_path,
        file_key="test_job_123/lab_1_.jpeg",
        bucket="test-health-vault-bucket",
    )

    # Must yield EXACTLY 0 visual assets
    assert len(extracted) == 0, f"Expected 0 visual assets on lab_1_.jpeg, got {len(extracted)}: {extracted}"
    assert s3_mock.upload_bytes.call_count == 0, "S3 upload should not have been called for 0 assets"
