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

    # No range provided
    "INR": {"value": 1.623, "status": "no_range"},

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


@pytest.mark.xfail(reason="Phase 2 Extraction Engine pending: spatial clustering yields >= 31 parameters")
def test_spatial_clustering_extracts_31_parameters():
    """Phase 2 requirement: Extraction from spatial words yields >= 31 lab test rows."""
    from app.services.pipeline.ocr_stage import OcrStageHandler
    # In Phase 0.5, spatial word-clustering pipeline is not yet implemented in ocr_stage.py
    extracted_params = []
    assert len(extracted_params) >= 31, f"Expected at least 31 rows, got {len(extracted_params)}"


@pytest.mark.xfail(reason="Phase 2 Extraction Engine pending: method names separated from testName")
def test_method_separated_from_test_name():
    """Phase 2 requirement: method strings like HPLC, Photo Optical, Photometric are separate attributes."""
    from app.services.pipeline.lab_evaluator import LabEvaluator
    raw_item = {"testName": "HbA1c HPLC", "value": 9.0}
    evaluated = LabEvaluator.evaluate_all([raw_item])[0]
    assert "HPLC" not in evaluated["testName"]
    assert evaluated.get("method") == "HPLC"


@pytest.mark.xfail(reason="Phase 3 Status Engine pending: tiered HbA1c and unit warning")
def test_hba1c_tiered_status_and_unit_warning():
    """Phase 3 requirement: HbA1c 9.0 -> diabetic tier with unit_warning if printed in mg/dL."""
    from app.services.pipeline.lab_evaluator import LabEvaluator
    res = LabEvaluator.evaluate_result("HbA1c", 9.0, unit="mg/dL")
    assert res["flag"] == "diabetic"
    assert res.get("unit_warning") is True


@pytest.mark.xfail(reason="Phase 3 Status Engine pending: calculated and mean values flagged as info")
def test_mean_and_calculated_values_are_info():
    """Phase 3 requirement: Mean Plasma Glucose, PT Mean, ISI flagged as info, not normal."""
    from app.services.pipeline.lab_evaluator import LabEvaluator
    res = LabEvaluator.evaluate_result("Mean Plasma Glucose", 212.20, unit="mg/dL")
    assert res["flag"] == "info"


@pytest.mark.xfail(reason="Phase 4 Patient Card pending: report date DD-MMM-YYYY and doctor name extracted")
def test_patient_metadata_extraction():
    """Phase 4 requirement: Report date 17-Jun-2025, Age 70, Female, Dr. HARDIK SUVAGIYA."""
    parsed = {}
    assert parsed.get("report_date") == "17-Jun-2025"
    assert parsed.get("doctor_name") == "Dr. HARDIK SUVAGIYA"

