"""
Phase 0.5 Contract Tests: Encodes expected results for the 5069200904 fixture report.
Marked with @pytest.mark.xfail pending Phase 2 (Extraction) and Phase 3 (Status Engine).
"""
import json
import pytest
from pathlib import Path

FIXTURE_WORDS_PATH = Path(__file__).parent.parent / "fixtures" / "fixture_words_pages_1_2.json"

EXPECTED_PARAMETERS = {
    # Low parameters
    "Hemoglobin": {"value": 11.20, "unit": "gm%", "status": "low"},
    "RBC": {"value": 3.76, "unit": "mil/cumm", "status": "low"},
    "Hematocrit": {"value": 34.40, "unit": "%", "status": "low"},
    "RDW-CV": {"value": 11.50, "unit": "%", "status": "low"},

    # High parameters
    "Random Blood Sugar": {"value": 271.0, "status": "high"},

    # Diabetic tier
    "HbA1c": {"value": 9.0, "status": "diabetic", "unit_warning": True},

    # Mildly high
    "Prothrombin Time (PT)": {"value": 18.5, "status": "mildly_high"},

    # Borderline high
    "Lymphocyte": {"value": 41.0, "unit": "%", "status": "borderline_high"},

    # Generic range provided (non-anticoagulated adult reference)
    "INR": {"value": 1.623, "status": "high", "range_source": "generic"},

    # Info parameters (calculated / mean values)
    "Mean Plasma Glucose": {"value": 212.20, "status": "info"},
}

EXPECTED_METADATA = {
    "report_date": "17-Jun-2025",
    "patient_age": 70,
    "patient_gender": "Female",
    "doctor_name": "Dr. HARDIK SUVAGIYA",
}


def test_fixture_words_dump_exists_and_anonymized():
    """Verifies that the anonymized words dump fixture exists and has pages 1 and 2."""
    assert FIXTURE_WORDS_PATH.exists(), f"Missing fixture at {FIXTURE_WORDS_PATH}"
    with open(FIXTURE_WORDS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    assert "page_1" in data and "page_2" in data
    assert len(data["page_1"]) > 100
    assert len(data["page_2"]) > 100


def test_spatial_clustering_extracts_31_parameters():
    """Phase 2 requirement: Extraction from spatial words yields >= 31 lab test rows."""
    from app.services.pipeline.ocr_stage import OcrStageHandler
    import fitz
    fixture_pdf = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "real_6page_digital.pdf"
    doc = fitz.open(fixture_pdf)
    extracted_params = OcrStageHandler.extract_spatial_parameters(doc)
    assert len(extracted_params) >= 31, f"Expected at least 31 rows, got {len(extracted_params)}"


def test_method_separated_from_test_name():
    """Phase 2 requirement: method strings like HPLC, Photo Optical, Photometric are separate attributes."""
    from app.services.pipeline.lab_evaluator import LabEvaluator
    raw_item = {"testName": "HbA1c HPLC", "value": 9.0}
    evaluated = LabEvaluator.evaluate_all([raw_item])[0]
    assert "HPLC" not in evaluated["testName"]
    assert evaluated.get("method") == "HPLC"


def test_hba1c_tiered_status_and_unit_warning():
    """Phase 3 requirement: HbA1c 9.0 -> diabetic tier with unit_warning if printed in mg/dL."""
    from app.services.pipeline.lab_evaluator import LabEvaluator
    res = LabEvaluator.evaluate_result("HbA1c", 9.0, unit="mg/dL")
    assert res["flag"] == "diabetic"
    assert res.get("unit_warning") is True


def test_mean_and_calculated_values_are_info():
    """Phase 3 requirement: Mean Plasma Glucose, PT Mean, ISI flagged as info, not normal."""
    from app.services.pipeline.lab_evaluator import LabEvaluator
    res = LabEvaluator.evaluate_result("Mean Plasma Glucose", 212.20, unit="mg/dL")
    assert res["flag"] == "info"


def test_patient_metadata_extraction():
    """Phase 2 requirement: Report date 17-Jun-2025, Age 70, Female, Dr. HARDIK SUVAGIYA."""
    from app.services.pipeline.spatial_row_builder import SpatialRowBuilder
    with open(FIXTURE_WORDS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)
    builder = SpatialRowBuilder()
    parsed = builder.extract_header_metadata(data["page_1"])
    assert parsed.get("report_date") == "17-Jun-2025"
    assert parsed.get("doctor_name") == "Dr. HARDIK SUVAGIYA"


def test_all_fixture_parameters_match_clinical_status_expectations():
    """Phase 3 requirement: All 34 parameters from fixture PDF match expected statuses and severities."""
    from app.services.pipeline.ocr_stage import OcrStageHandler
    from app.services.pipeline.lab_evaluator import LabEvaluator
    import fitz

    fixture_pdf = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "real_6page_digital.pdf"
    doc = fitz.open(fixture_pdf)
    extracted_params = OcrStageHandler.extract_spatial_parameters(doc)
    evaluated = LabEvaluator.evaluate_all(extracted_params)
    assert len(evaluated) >= 31

    eval_by_name = {p["testName"]: p for p in evaluated}

    # Low parameters
    assert eval_by_name["Hemoglobin"]["status"] == "low"
    assert eval_by_name["Hemoglobin"]["lab_flag"] == "L"
    assert eval_by_name["Hemoglobin"]["flag_conflict"] is False

    assert eval_by_name["RBC Count"]["status"] == "low"
    assert eval_by_name["RBC Count"]["lab_flag"] == "L"
    assert eval_by_name["RBC Count"]["flag_conflict"] is False

    assert eval_by_name["Hematocrit/PCV"]["status"] == "low"
    assert eval_by_name["Hematocrit/PCV"]["lab_flag"] == "L"
    assert eval_by_name["Hematocrit/PCV"]["flag_conflict"] is False

    assert eval_by_name["RDW-CV"]["status"] == "low"
    assert eval_by_name["RDW-CV"]["lab_flag"] == "L"
    assert eval_by_name["RDW-CV"]["flag_conflict"] is False

    # High parameters
    assert eval_by_name["Random Blood Sugar"]["status"] == "high"
    assert eval_by_name["Random Blood Sugar"]["value"] == 271.0

    # Diabetic tier + unit warning
    assert eval_by_name["Hba1c"]["status"] == "diabetic"
    assert eval_by_name["Hba1c"]["unit_warning"] is True

    # PT: high, borderline/mild, lab flag none -> flag_conflict False
    assert eval_by_name["Patients Value (PT)"]["status"] == "high"
    assert eval_by_name["Patients Value (PT)"]["severity"] in ("borderline", "mild")
    assert eval_by_name["Patients Value (PT)"]["flag_conflict"] is False

    # Lymphocyte: high, borderline; absolute normal
    assert eval_by_name["Lymphocyte"]["status"] == "high"
    assert eval_by_name["Lymphocyte"]["severity"] == "borderline"
    assert eval_by_name["Lymphocyte (Absolute)"]["status"] == "normal"

    # Generic reference for INR (depends on enable_generic_inr_range flag)
    from app.settings import settings
    if settings.enable_generic_inr_range:
        assert eval_by_name["INR"]["status"] == "high"
        assert eval_by_name["INR"]["range_source"] == "generic"
    else:
        assert eval_by_name["INR"]["status"] == "no_range"
        assert eval_by_name["INR"]["referenceRange"] is None
    assert eval_by_name["Basophils (Absolute)"]["status"] == "no_range"
    assert eval_by_name["Basophils (Absolute)"]["referenceRange"] is None

    # HbA1c tiers preserved in payload
    assert "tiers" in eval_by_name["Hba1c"]
    assert len(eval_by_name["Hba1c"]["tiers"]) >= 3

    # Informational
    assert eval_by_name["Mean Plasma Glucose"]["status"] == "info"
    assert eval_by_name["Mean Value (APTT)"]["status"] == "info"
    assert eval_by_name["Ratio (APTT)"]["status"] == "info"
    assert eval_by_name["Mean Value (PT)"]["status"] == "info"
    assert eval_by_name["ISI"]["status"] == "info"

    # Everything else normal
    normal_keys = [
        "WBC Count", "Platelet Count", "Polymorphs", "Polymorphs (Absolute)",
        "Eosinophils", "Eosinophils (Absolute)", "Monocytes", "Monocytes (Absolute)",
        "Basophils", "MCV", "MCH", "MCHC", "Bleeding Time", "Clotting Time",
        "Patient Value (APTT)", "T3 (Triiodothyronine)", "T4 (Thyroxine)",
        "TSH(Thyroid Stimulating Hormone)"
    ]
    for k in normal_keys:
        assert eval_by_name[k]["status"] == "normal", f"Expected normal for {k}, got {eval_by_name[k]['status']}"



