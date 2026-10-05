import json
from pathlib import Path
import pytest
import fitz

from app.services.pipeline.spatial_row_builder import SpatialRowBuilder
from app.services.pipeline.ocr_stage import OcrStageHandler

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
FIXTURE_WORDS_PATH = FIXTURES_DIR / "fixture_words_pages_1_2.json"
FIXTURE_PDF_PATH = FIXTURES_DIR / "golden_docs" / "real_6page_digital.pdf"


def test_spatial_row_builder_clusters_by_y_band_from_median_height():
    """Verify that word bounding boxes are clustered into horizontal visual rows using median word height tolerance."""
    # Synthetic words on two rows with slight y jitter
    words = [
        {"x0": 45.0, "y0": 100.0, "x1": 120.0, "y1": 112.0, "word": "Hemoglobin"},
        {"x0": 200.0, "y0": 101.5, "x1": 210.0, "y1": 113.0, "word": "L"},
        {"x0": 212.0, "y0": 99.8, "x1": 245.0, "y1": 112.2, "word": "11.20"},
        {"x0": 290.0, "y0": 100.5, "x1": 320.0, "y1": 112.5, "word": "gm%"},
        {"x0": 440.0, "y0": 100.2, "x1": 490.0, "y1": 112.8, "word": "12-15"},
        # Next row
        {"x0": 45.0, "y0": 125.0, "x1": 110.0, "y1": 137.0, "word": "RBC"},
        {"x0": 212.0, "y0": 124.5, "x1": 245.0, "y1": 136.8, "word": "3.76"},
    ]
    builder = SpatialRowBuilder()
    rows = builder.cluster_words_to_rows(words)
    assert len(rows) == 2
    assert "Hemoglobin" in " ".join(w["word"] for w in rows[0])
    assert "RBC" in " ".join(w["word"] for w in rows[1])


def test_spatial_row_builder_fixture_pages_1_and_2():
    """Verify extraction on fixture_words_pages_1_2.json: CBC and Bleeding/Clotting present."""
    assert FIXTURE_WORDS_PATH.exists()
    with open(FIXTURE_WORDS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    builder = SpatialRowBuilder()
    
    # Page 1: CBC
    page_1_params = builder.extract_parameters_from_words(data["page_1"], page_number=1)
    p1_names = {p["testName"] for p in page_1_params}
    
    # Check key CBC analytes
    assert any("Hemoglobin" in name for name in p1_names)
    assert any("RBC" in name for name in p1_names)
    assert any("Platelet" in name for name in p1_names)
    assert any("Hematocrit" in name for name in p1_names)
    assert any("RDW" in name for name in p1_names)
    
    # Check differential rows map % and absolute values
    assert "Lymphocyte" in p1_names
    assert "Lymphocyte (Absolute)" in p1_names or any(p.get("value_abs") for p in page_1_params if p["testName"] == "Lymphocyte")
    
    # Check flag L preserved for Hemoglobin
    hb = next(p for p in page_1_params if "Hemoglobin" in p["testName"])
    assert hb["flag"] == "L"
    assert "11.20" in str(hb["value_raw"])

    # Page 2: Bleeding and Clotting
    page_2_params = builder.extract_parameters_from_words(data["page_2"], page_number=2)
    p2_names = {p["testName"] for p in page_2_params}
    assert any("Bleeding Time" in name for name in p2_names)
    assert any("Clotting Time" in name for name in p2_names)


def test_spatial_row_builder_all_6_pages_extracts_at_least_31_parameters():
    """Verify that running spatial row builder across all 6 pages yields >= 31 parameters,
    with all CBC and Bleeding/Clotting present."""
    assert FIXTURE_PDF_PATH.exists()
    doc = fitz.open(FIXTURE_PDF_PATH)
    
    builder = SpatialRowBuilder()
    all_params = builder.extract_parameters_from_doc(doc)
    
    # At least 31 parameters across the 6 pages
    assert len(all_params) >= 31, f"Expected at least 31 parameters, got {len(all_params)}"
    
    names = {p["testName"] for p in all_params}
    
    # All CBC present
    cbc_required = [
        "Hemoglobin", "RBC Count", "WBC Count", "Platelet Count",
        "Polymorphs", "Lymphocyte", "Eosinophils", "Monocytes", "Basophils",
        "Hematocrit/PCV", "MCV", "MCH", "MCHC", "RDW-CV"
    ]
    for req in cbc_required:
        assert any(req.lower() in name.lower() for name in names), f"Missing CBC parameter: {req}"

    # Bleeding / Clotting present
    assert any("Bleeding Time" in name for name in names), "Missing Bleeding Time"
    assert any("Clotting Time" in name for name in names), "Missing Clotting Time"

    # Also check other key analytes
    assert any("Random Blood Sugar" in name for name in names), "Missing Random Blood Sugar"
    assert any("HbA1c" in name or "Hba1c" in name for name in names), "Missing HbA1c"
    assert any("INR" in name for name in names), "Missing INR"
    assert any("T3" in name for name in names), "Missing T3"
    assert any("T4" in name for name in names), "Missing T4"
    assert any("TSH" in name for name in names), "Missing TSH"

    # Verify OcrStageHandler integration
    ocr_handler_params = OcrStageHandler.extract_spatial_parameters(doc)
    assert len(ocr_handler_params) >= 31
