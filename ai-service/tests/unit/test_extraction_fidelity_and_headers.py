import json
from datetime import date
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4
import pytest

from app.services.pipeline.spatial_row_builder import SpatialRowBuilder
from app.services.pipeline.lab_evaluator import LabEvaluator
from app.infrastructure.db.repositories.job_repository import JobRepository

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures"
FIXTURE_WORDS_PATH = FIXTURES_DIR / "fixture_words_pages_1_2.json"


def test_value_raw_fidelity_and_unit_preservation():
    """Verify that value_raw preserves exact printed representation and unit normalizes U+00B5/U+03BC to 'µ'."""
    builder = SpatialRowBuilder()
    
    assert builder.normalize_unit("µg/dL") == "µg/dL"
    assert builder.normalize_unit("\u03bcg/dL") == "µg/dL"
    assert builder.normalize_unit("\u00b5g/dL") == "µg/dL"
    assert builder.normalize_unit("\ufffdg/dL") == "µg/dL"
    assert builder.normalize_unit("micro g/dL") == "µg/dL"

    with open(FIXTURE_WORDS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    page_2_params = builder.extract_parameters_from_words(data["page_2"], page_number=2)
    bleeding = next(p for p in page_2_params if "Bleeding Time" in p["testName"])
    assert bleeding["value_raw"] == "02 Min 15 Sec"


def test_method_separation_and_method_only_row_exclusion():
    """Verify method separation from testName in SpatialRowBuilder and LabEvaluator,
    and verify method-only rows are never extracted as parameters."""
    builder = SpatialRowBuilder()

    # Synthetic rows including method-only rows
    method_rows = [
        {"x0": 45.0, "y0": 260.0, "x1": 150.0, "y1": 272.0, "word": "GOD POD"},
        {"x0": 45.0, "y0": 280.0, "x1": 150.0, "y1": 292.0, "word": "CLIA"},
        {"x0": 45.0, "y0": 300.0, "x1": 150.0, "y1": 312.0, "word": "Photo Optical"},
        {"x0": 45.0, "y0": 320.0, "x1": 150.0, "y1": 332.0, "word": "Calculation"},
        {"x0": 45.0, "y0": 340.0, "x1": 150.0, "y1": 352.0, "word": "Clotting Based Assay"},
    ]
    clusters = builder.cluster_words_to_rows(method_rows)
    for cl in clusters:
        text = " ".join(w["word"] for w in cl)
        assert builder.is_method_only_row(text) is True

    # LabEvaluator separation
    raw_item = {"testName": "HbA1c HPLC", "value": 9.0}
    evaluated = LabEvaluator.evaluate_all([raw_item])[0]
    assert "HPLC" not in evaluated["testName"]
    assert evaluated.get("method") == "HPLC"

    raw_item2 = {"testName": "Hemoglobin (Photometric)", "value": 11.2}
    evaluated2 = LabEvaluator.evaluate_all([raw_item2])[0]
    assert "Photometric" not in evaluated2["testName"]
    assert evaluated2.get("method") == "Photometric"


def test_header_metadata_extraction_from_words():
    """Verify extraction of name, age+sex, doctor, sample date, report date from word data."""
    with open(FIXTURE_WORDS_PATH, "r", encoding="utf-8") as f:
        data = json.load(f)

    builder = SpatialRowBuilder()
    metadata = builder.extract_header_metadata(data["page_1"])

    assert metadata["patient_name"] == "Manjulaben Ranoliya"
    assert metadata["patient_age"] == 70
    assert metadata["patient_gender"] == "Female"
    assert metadata["patient_age_sex"] == "Female / 70 Years"
    assert metadata["doctor_name"] == "Dr. HARDIK SUVAGIYA"
    assert metadata["sample_date"] == "17-Jun-2025"
    assert metadata["report_date"] == "17-Jun-2025"
    assert "Green Cross" in metadata["hospital_name"]


@pytest.mark.asyncio
async def test_sync_to_documents_table_persists_report_date_doctor_hospital():
    """Verify that sync_to_documents_table (S7) persists report_date, doctor_name, and hospital_name."""
    mock_db = MagicMock()
    mock_session = AsyncMock()

    async def session_generator():
        yield mock_session

    mock_db.session = session_generator
    repo = JobRepository(mock_db)

    doc_id = uuid4()
    structured_data = {
        "summaryEnglish": "Patient blood report summary.",
        "reportDate": "17-Jun-2025",
        "doctorName": "Dr. HARDIK SUVAGIYA",
        "hospitalName": "Green Cross Genetics Lab PVT. LTD. Junagadh",
        "patientInfo": {
            "name": "Manjulaben Ranoliya",
            "age": 70,
            "gender": "Female",
        },
    }

    await repo.sync_to_documents_table(
        document_id=doc_id,
        extracted_structured_data=structured_data,
        raw_ocr_data={"fullText": "RAW REPORT TEXT"},
    )

    mock_session.execute.assert_called_once()
    mock_session.commit.assert_called_once()

    call_args = mock_session.execute.call_args
    sql_text = str(call_args[0][0])
    params = call_args[0][1]

    # Verify SQL query includes the new columns
    assert "report_date = COALESCE(:report_date, report_date)" in sql_text
    assert "doctor_name = COALESCE(:doctor_name, doctor_name)" in sql_text
    assert "hospital_name = COALESCE(:hospital_name, hospital_name)" in sql_text

    # Verify parameter mapping
    assert params["document_id"] == doc_id
    assert params["report_date"] == date(2025, 6, 17)
    assert params["doctor_name"] == "Dr. HARDIK SUVAGIYA"
    assert params["hospital_name"] == "Green Cross Genetics Lab PVT. LTD. Junagadh"
    assert params["summary_english"] == "Patient blood report summary."
