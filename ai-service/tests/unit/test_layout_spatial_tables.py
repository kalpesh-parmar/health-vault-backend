"""Unit and regression tests for spatial layout decomposition and table reconstruction.

Tests:
1. Normalization across polygon quads, 2-point boxes, 4-tuples, numpy arrays, and malformed inputs.
2. Deterministic spatial row clustering with vertical proximity and left-to-right sorting.
3. Borderless lab result table reconstruction with headers, results, units, reference intervals.
4. Borderless prescription table reconstruction with medicine names, doses, quantities.
5. Negative controls: single-column clinical narrative text producing zero false-positive tables.
6. Text-only fallback path for documents without bounding boxes (markdown/bordered tables).
7. Confidence and provenance preservation across table cells.
8. Telemetry metrics emission (all 11 required spans and counters).
9. End-to-end golden regression on lab_1_.jpeg fixture.
"""
from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import MagicMock

import numpy as np
import pytest

from app.services.pipeline.layout_stage import LayoutStageHandler


# ------------------------------------------------------------------------------
# 1. Bounding Box Normalization Tests
# ------------------------------------------------------------------------------
def test_normalize_bounding_box_formats():
    # 4-point polygon clockwise from top-left
    poly_quad = [[10.0, 20.0], [100.0, 20.0], [100.0, 50.0], [10.0, 50.0]]
    b1 = LayoutStageHandler._normalize_bounding_box(poly_quad)
    assert b1 is not None
    assert b1["x1"] == 10.0
    assert b1["y1"] == 20.0
    assert b1["x2"] == 100.0
    assert b1["y2"] == 50.0
    assert b1["width"] == 90.0
    assert b1["height"] == 30.0
    assert b1["cx"] == 55.0
    assert b1["cy"] == 35.0

    # NumPy array polygon
    np_quad = np.array(poly_quad, dtype=np.float32)
    b2 = LayoutStageHandler._normalize_bounding_box(np_quad)
    assert b2 == b1

    # 4-element list [x1, y1, x2, y2]
    rect_4 = [15.0, 25.0, 115.0, 55.0]
    b3 = LayoutStageHandler._normalize_bounding_box(rect_4)
    assert b3 is not None
    assert b3["x1"] == 15.0
    assert b3["y1"] == 25.0
    assert b3["x2"] == 115.0
    assert b3["y2"] == 55.0

    # 2-point diagonal [[x1, y1], [x2, y2]]
    diag_2 = [[15.0, 25.0], [115.0, 55.0]]
    b4 = LayoutStageHandler._normalize_bounding_box(diag_2)
    assert b4 == b3

    # Inverted coordinates: [x2, y2, x1, y1]
    inverted_4 = [115.0, 55.0, 15.0, 25.0]
    b5 = LayoutStageHandler._normalize_bounding_box(inverted_4)
    assert b5 is not None
    assert b5["x1"] == 15.0
    assert b5["y1"] == 25.0

    # Missing / None / Empty / Malformed
    assert LayoutStageHandler._normalize_bounding_box(None) is None
    assert LayoutStageHandler._normalize_bounding_box([]) is None
    assert LayoutStageHandler._normalize_bounding_box("invalid") is None
    assert LayoutStageHandler._normalize_bounding_box([10.0, 20.0]) is None


# ------------------------------------------------------------------------------
# 2. Spatial Row Clustering & Deterministic Ordering Tests
# ------------------------------------------------------------------------------
def test_spatial_row_clustering_deterministic_ordering():
    handler = LayoutStageHandler(row_vertical_tolerance=0.65)

    # 3 lines of 2 items each, intentionally unordered in input
    items = [
        {"text": "Line 2 Col 2", "box": {"x1": 200, "y1": 50, "x2": 350, "y2": 70, "cx": 275, "cy": 60, "width": 150, "height": 20}},
        {"text": "Line 1 Col 1", "box": {"x1": 20, "y1": 10, "x2": 150, "y2": 30, "cx": 85, "cy": 20, "width": 130, "height": 20}},
        {"text": "Line 3 Col 1", "box": {"x1": 20, "y1": 90, "x2": 150, "y2": 110, "cx": 85, "cy": 100, "width": 130, "height": 20}},
        {"text": "Line 1 Col 2", "box": {"x1": 200, "y1": 12, "x2": 350, "y2": 32, "cx": 275, "cy": 22, "width": 150, "height": 20}},
        {"text": "Line 3 Col 2", "box": {"x1": 200, "y1": 92, "x2": 350, "y2": 112, "cx": 275, "cy": 102, "width": 150, "height": 20}},
        {"text": "Line 2 Col 1", "box": {"x1": 20, "y1": 48, "x2": 150, "y2": 68, "cx": 85, "cy": 58, "width": 130, "height": 20}},
    ]

    visual_rows = handler._cluster_spatial_rows(items)
    assert len(visual_rows) == 3

    # Row 0: Line 1
    assert visual_rows[0]["items"][0]["text"] == "Line 1 Col 1"
    assert visual_rows[0]["items"][1]["text"] == "Line 1 Col 2"

    # Row 1: Line 2
    assert visual_rows[1]["items"][0]["text"] == "Line 2 Col 1"
    assert visual_rows[1]["items"][1]["text"] == "Line 2 Col 2"

    # Row 2: Line 3
    assert visual_rows[2]["items"][0]["text"] == "Line 3 Col 1"
    assert visual_rows[2]["items"][1]["text"] == "Line 3 Col 2"


# ------------------------------------------------------------------------------
# 3. Borderless Lab Table Reconstruction
# ------------------------------------------------------------------------------
def test_borderless_lab_table_reconstruction():
    handler = LayoutStageHandler()

    # Construct spatial lines simulating a CBC lab report
    raw_lines = [
        # Report Title
        {"text": "COMPLETE BLOOD COUNT (CBC)", "confidence": 0.99, "box": [50, 20, 450, 45]},
        # Header Row (y ~ 80)
        {"text": "Test Parameter", "confidence": 0.98, "box": [50, 75, 200, 95]},
        {"text": "Observed Result", "confidence": 0.97, "box": [240, 75, 340, 95]},
        {"text": "Unit", "confidence": 0.98, "box": [380, 75, 430, 95]},
        {"text": "Biological Ref Interval", "confidence": 0.96, "box": [470, 75, 620, 95]},
        # Row 1: Hemoglobin (y ~ 115)
        {"text": "Hemoglobin", "confidence": 0.99, "box": [50, 110, 160, 130]},
        {"text": "14.2", "confidence": 0.99, "box": [250, 110, 290, 130]},
        {"text": "g/dL", "confidence": 0.98, "box": [380, 110, 420, 130]},
        {"text": "12.0 - 17.5", "confidence": 0.95, "box": [470, 110, 560, 130]},
        # Row 2: Total RBC Count (y ~ 145)
        {"text": "Total RBC Count", "confidence": 0.98, "box": [50, 140, 180, 160]},
        {"text": "4.8", "confidence": 0.99, "box": [250, 140, 280, 160]},
        {"text": "mill/cumm", "confidence": 0.97, "box": [380, 140, 450, 160]},
        {"text": "4.5 - 5.5", "confidence": 0.95, "box": [470, 140, 540, 160]},
        # Row 3: Platelet Count (y ~ 175)
        {"text": "Platelet Count", "confidence": 0.98, "box": [50, 170, 170, 190]},
        {"text": "240000", "confidence": 0.99, "box": [250, 170, 310, 190]},
        {"text": "/cumm", "confidence": 0.97, "box": [380, 170, 430, 190]},
        {"text": "150000 - 450000", "confidence": 0.94, "box": [470, 170, 580, 190]},
    ]

    raw_ocr_data = {
        "pages": [{"page": 1, "text": "COMPLETE BLOOD COUNT...", "lines": raw_lines}],
        "fullText": "COMPLETE BLOOD COUNT...",
    }

    result = handler.parse_layout(raw_ocr_data)
    assert len(result["tables"]) == 1
    table = result["tables"][0]

    assert table["headers"] == ["Test Parameter", "Observed Result", "Unit", "Biological Ref Interval"]
    assert table["rowCount"] == 3
    assert table["colCount"] == 4
    assert table["rows"][0] == ["Hemoglobin", "14.2", "g/dL", "12.0 - 17.5"]
    assert table["rows"][1] == ["Total RBC Count", "4.8", "mill/cumm", "4.5 - 5.5"]
    assert table["rows"][2] == ["Platelet Count", "240000", "/cumm", "150000 - 450000"]
    assert table["confidence"] >= 0.95
    assert "provenance" in table


# ------------------------------------------------------------------------------
# 4. Borderless Prescription Table Reconstruction
# ------------------------------------------------------------------------------
def test_borderless_prescription_table_reconstruction():
    handler = LayoutStageHandler()

    raw_lines = [
        # Prescription Header (y ~ 50)
        {"text": "DRUG NAME", "confidence": 0.98, "box": [20, 50, 180, 70]},
        {"text": "DOSAGE", "confidence": 0.97, "box": [220, 50, 300, 70]},
        {"text": "FREQUENCY", "confidence": 0.96, "box": [340, 50, 440, 70]},
        {"text": "QTY", "confidence": 0.98, "box": [480, 50, 520, 70]},
        # Row 1 (y ~ 85)
        {"text": "Tab. Paracetamol", "confidence": 0.99, "box": [20, 85, 170, 105]},
        {"text": "650 mg", "confidence": 0.98, "box": [220, 85, 280, 105]},
        {"text": "1-0-1", "confidence": 0.97, "box": [340, 85, 380, 105]},
        {"text": "10", "confidence": 0.99, "box": [480, 85, 500, 105]},
        # Row 2 (y ~ 120)
        {"text": "Cap. Amoxicillin", "confidence": 0.98, "box": [20, 120, 160, 140]},
        {"text": "500 mg", "confidence": 0.98, "box": [220, 120, 280, 140]},
        {"text": "1-1-1", "confidence": 0.97, "box": [340, 120, 380, 140]},
        {"text": "15", "confidence": 0.99, "box": [480, 120, 500, 140]},
    ]

    raw_ocr_data = {
        "pages": [{"page": 1, "text": "PRESCRIPTION...", "lines": raw_lines}],
        "fullText": "PRESCRIPTION...",
    }

    result = handler.parse_layout(raw_ocr_data)
    assert len(result["tables"]) == 1
    table = result["tables"][0]
    assert table["headers"] == ["DRUG NAME", "DOSAGE", "FREQUENCY", "QTY"]
    assert table["rowCount"] == 2
    assert table["rows"][0] == ["Tab. Paracetamol", "650 mg", "1-0-1", "10"]
    assert table["rows"][1] == ["Cap. Amoxicillin", "500 mg", "1-1-1", "15"]


# ------------------------------------------------------------------------------
# 5. Negative Control: Single Column Text Produces No False Tables
# ------------------------------------------------------------------------------
def test_single_column_clinical_narrative_produces_no_tables():
    handler = LayoutStageHandler()

    raw_lines = [
        {"text": "CHIEF COMPLAINTS", "confidence": 0.99, "box": [30, 20, 250, 40]},
        {"text": "Patient reports severe cough and mild fever for 3 days.", "confidence": 0.97, "box": [30, 50, 500, 70]},
        {"text": "No history of chest pain or shortness of breath.", "confidence": 0.98, "box": [30, 80, 450, 100]},
        {"text": "DIAGNOSIS", "confidence": 0.99, "box": [30, 120, 160, 140]},
        {"text": "Upper Respiratory Tract Infection (URTI)", "confidence": 0.98, "box": [30, 150, 400, 170]},
    ]

    raw_ocr_data = {
        "pages": [{"page": 1, "text": "CHIEF COMPLAINTS...", "lines": raw_lines}],
        "fullText": "CHIEF COMPLAINTS...",
    }

    result = handler.parse_layout(raw_ocr_data)
    assert len(result["tables"]) == 0
    assert result["metrics"]["table_count"] == 0
    assert len(result["sections"]) >= 1


# ------------------------------------------------------------------------------
# 6. Text-Only Fallback Path (No Bounding Boxes)
# ------------------------------------------------------------------------------
def test_text_only_fallback_path_extracts_markdown_table():
    handler = LayoutStageHandler()

    # Document without spatial boxes (e.g. from office_direct or digital vector text)
    raw_ocr_data = {
        "pages": [
            {
                "page": 1,
                "text": (
                    "LABORATORY INVESTIGATION REPORT\n"
                    "| Parameter | Observed | Unit | Normal |\n"
                    "|---|---|---|---|\n"
                    "| Blood Urea | 28 | mg/dL | 15 - 45 |\n"
                    "| Serum Creatinine | 0.9 | mg/dL | 0.6 - 1.2 |\n"
                ),
                # "lines" is absent or has no "box"
                "lines": [],
            }
        ],
        "fullText": "LABORATORY INVESTIGATION REPORT...",
    }

    result = handler.parse_layout(raw_ocr_data)
    assert len(result["tables"]) == 1
    table = result["tables"][0]
    assert table["headers"] == ["Parameter", "Observed", "Unit", "Normal"]
    assert table["rowCount"] == 2
    assert table["rows"][0][0] == "Blood Urea"
    assert table["rows"][1][0] == "Serum Creatinine"
    assert result["metrics"]["has_spatial_boxes"] is False


# ------------------------------------------------------------------------------
# 7. Telemetry Metrics Verification
# ------------------------------------------------------------------------------
def test_telemetry_metrics_contract():
    handler = LayoutStageHandler()
    raw_ocr_data = {
        "pages": [
            {
                "page": 1,
                "text": "Header\nItem 1",
                "lines": [
                    {"text": "Header", "confidence": 0.95, "box": [10, 10, 50, 30]},
                    {"text": "Item 1", "confidence": 0.90, "box": [10, 40, 50, 60]},
                ],
            }
        ]
    }

    result = handler.parse_layout(raw_ocr_data)
    metrics = result.get("metrics")
    assert metrics is not None

    required_keys = [
        "layout_total_ms",
        "spatial_cluster_ms",
        "table_extraction_ms",
        "column_reorder_ms",
        "section_classification_ms",
        "page_count",
        "raw_line_count",
        "visual_line_count",
        "table_count",
        "table_row_count",
        "section_count",
        "has_spatial_boxes",
    ]
    for k in required_keys:
        assert k in metrics, f"Missing telemetry metric: {k}"

    assert isinstance(metrics["layout_total_ms"], float)
    assert metrics["page_count"] == 1
    assert metrics["raw_line_count"] == 2
    assert metrics["has_spatial_boxes"] is True


# ------------------------------------------------------------------------------
# 8. Golden Regression on lab_1_.jpeg
# ------------------------------------------------------------------------------
def test_regression_lab_1_jpeg_golden_document():
    from app.modules.ocr.paddle_engine import PaddleOcrEngine
    from app.modules.ocr.quality_gate import QualityGate
    from app.services.pipeline.ocr_stage import OcrStageHandler

    fixture_path = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert fixture_path.is_file(), f"Fixture missing at {fixture_path}"

    image_bytes = fixture_path.read_bytes()
    engine = PaddleOcrEngine.get_instance(lang="en", bypass_orientation=True, cpu_threads=4)
    from unittest.mock import AsyncMock
    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "કોલ બાંધા નાં 30 કિસા વાંચ આદુ\nફરી બતાવવા માટે 30 દિવસ પછી આવવું",
        "confidence": 0.95,
    })
    ocr_handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=engine,
        quality_gate=QualityGate(),
    )

    page_res = asyncio.run(ocr_handler._extract_page_with_tiered_ocr(image_bytes, page_num=1))
    assert page_res["status"] == "FALLBACK"
    assert page_res["engine"] == "hybrid_paddle_vlm"
    assert len(page_res["lines"]) >= 32

    raw_ocr = {
        "pages": [page_res],
        "fullText": page_res.get("text", ""),
        "confidence": page_res.get("confidence", 0.0),
        "pageCount": 1,
    }

    handler = LayoutStageHandler()
    layout_data = handler.parse_layout(raw_ocr)

    # 1. Verify tables >= 1 (TABLE-03)
    assert len(layout_data["tables"]) >= 1, f"Expected tables >= 1, got {len(layout_data['tables'])}"
    table = layout_data["tables"][0]

    # 2. Verify headers
    headers_str = " ".join(table["headers"]).upper()
    assert "MEDICINE" in headers_str or "NAME" in headers_str
    assert "DOSE" in headers_str or "DURATION" in headers_str

    # 3. Verify data rows
    assert table["rowCount"] >= 2
    rows_str = " ".join(" ".join(r) for r in table["rows"]).upper()
    assert "MBSON" in rows_str or "CALDISON" in rows_str

    # 4. Verify telemetry spans
    metrics = layout_data["metrics"]
    assert metrics["has_spatial_boxes"] is True
    assert metrics["layout_total_ms"] < 25.0, f"Layout stage exceeded latency budget: {metrics['layout_total_ms']}ms"
    assert metrics["raw_line_count"] >= 32
    assert metrics["table_count"] >= 1
