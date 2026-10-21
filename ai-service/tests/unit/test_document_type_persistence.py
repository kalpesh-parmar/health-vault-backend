from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock
import pytest

from app.infrastructure.db.repositories.job_repository import (
    JobRepository,
    normalize_document_type,
    CANONICAL_DOCUMENT_TYPES,
)


@pytest.mark.parametrize(
    "raw_input,expected",
    [
        # All 9 canonical types
        ("LAB_REPORT", "LAB_REPORT"),
        ("PRESCRIPTION", "PRESCRIPTION"),
        ("IMAGING_REPORT", "IMAGING_REPORT"),
        ("DISCHARGE_SUMMARY", "DISCHARGE_SUMMARY"),
        ("CONSULTATION_REPORT", "CONSULTATION_REPORT"),
        ("SURGERY_PROCEDURE_REPORT", "SURGERY_PROCEDURE_REPORT"),
        ("VACCINATION_RECORD", "VACCINATION_RECORD"),
        ("MEDICAL_CERTIFICATE", "MEDICAL_CERTIFICATE"),
        ("OTHER_MEDICAL_DOCUMENT", "OTHER_MEDICAL_DOCUMENT"),
        # Required Aliases
        ("TEST REPORT", "LAB_REPORT"),
        ("test_report", "LAB_REPORT"),
        ("USG", "IMAGING_REPORT"),
        ("usg", "IMAGING_REPORT"),
        ("ULTRASOUND", "IMAGING_REPORT"),
        ("X-RAY", "IMAGING_REPORT"),
        ("xray", "IMAGING_REPORT"),
        ("Rx", "PRESCRIPTION"),
        ("rx", "PRESCRIPTION"),
        ("DISCHARGE", "DISCHARGE_SUMMARY"),
        # Additional clinical variations
        ("CBC", "LAB_REPORT"),
        ("blood report", "LAB_REPORT"),
        ("pathology", "LAB_REPORT"),
        ("MRI Scan", "IMAGING_REPORT"),
        ("CT SCAN", "IMAGING_REPORT"),
        ("diagnostic imaging", "IMAGING_REPORT"),
        ("Doctor Note", "CONSULTATION_REPORT"),
        ("OPD Note", "CONSULTATION_REPORT"),
        ("Surgery Report", "SURGERY_PROCEDURE_REPORT"),
        ("Operative Note", "SURGERY_PROCEDURE_REPORT"),
        ("Vaccine Card", "VACCINATION_RECORD"),
        ("Immunization Record", "VACCINATION_RECORD"),
        ("Fitness Certificate", "MEDICAL_CERTIFICATE"),
        # Explicit other
        ("other", "OTHER_MEDICAL_DOCUMENT"),
        ("other medical document", "OTHER_MEDICAL_DOCUMENT"),
    ],
)
def test_normalize_document_type_valid_and_aliases(raw_input, expected):
    result = normalize_document_type(raw_input)
    assert result == expected
    assert result in CANONICAL_DOCUMENT_TYPES


@pytest.mark.parametrize(
    "invalid_input",
    [
        None,
        "",
        "   ",
        "RANDOM_INVALID_STRING_12345",
        "UNKNOWN_NON_MEDICAL_RECEIPT",
        12345,
        {},
    ],
)
def test_normalize_document_type_missing_or_invalid_returns_none(invalid_input):
    """Missing or invalid classification must return None to preserve existing DB value via COALESCE."""
    result = normalize_document_type(invalid_input)
    assert result is None


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "extracted_doc_type,expected_db_param",
    [
        ("LAB_REPORT", "LAB_REPORT"),
        ("PRESCRIPTION", "PRESCRIPTION"),
        ("IMAGING_REPORT", "IMAGING_REPORT"),
        ("DISCHARGE_SUMMARY", "DISCHARGE_SUMMARY"),
        ("CONSULTATION_REPORT", "CONSULTATION_REPORT"),
        ("SURGERY_PROCEDURE_REPORT", "SURGERY_PROCEDURE_REPORT"),
        ("VACCINATION_RECORD", "VACCINATION_RECORD"),
        ("MEDICAL_CERTIFICATE", "MEDICAL_CERTIFICATE"),
        ("OTHER_MEDICAL_DOCUMENT", "OTHER_MEDICAL_DOCUMENT"),
        ("TEST REPORT", "LAB_REPORT"),
        ("USG", "IMAGING_REPORT"),
        ("Ultrasound", "IMAGING_REPORT"),
        ("X-Ray Report", "IMAGING_REPORT"),
        ("Rx", "PRESCRIPTION"),
        ("Discharge", "DISCHARGE_SUMMARY"),
    ],
)
async def test_sync_to_documents_table_persists_canonical_document_types(
    extracted_doc_type, expected_db_param
):
    mock_db = MagicMock()
    mock_session = AsyncMock()

    async def mock_session_gen():
        yield mock_session

    mock_db.session.return_value = mock_session_gen()
    repo = JobRepository(mock_db)
    doc_id = uuid.uuid4()

    extracted_data = {
        "documentInfo": {
            "documentType": extracted_doc_type,
            "documentDate": "2026-10-16",
        },
        "summaryEnglish": "Clinical summary",
    }

    await repo.sync_to_documents_table(
        document_id=doc_id,
        extracted_structured_data=extracted_data,
        raw_ocr_data={"fullText": "Sample document"},
    )

    assert mock_session.execute.called
    call_args = mock_session.execute.call_args
    query_obj = call_args[0][0]
    params = call_args[0][1]

    # Verify SQL includes document_type parameter with casting and COALESCE
    assert "document_type = COALESCE(CAST(:doc_type AS document_type), document_type)" in query_obj.text
    assert params["document_id"] == doc_id
    assert params["doc_type"] == expected_db_param
    assert params["doc_ocr_status"] == "completed"


@pytest.mark.asyncio
async def test_sync_to_documents_table_missing_or_invalid_leaves_doc_type_none():
    mock_db = MagicMock()
    mock_session = AsyncMock()

    async def mock_session_gen():
        yield mock_session

    mock_db.session.return_value = mock_session_gen()
    repo = JobRepository(mock_db)
    doc_id = uuid.uuid4()

    # Invalid classification
    extracted_data = {
        "documentInfo": {
            "documentType": "GARBAGE_CLASSIFICATION_XYZ",
        },
    }

    await repo.sync_to_documents_table(
        document_id=doc_id,
        extracted_structured_data=extracted_data,
        raw_ocr_data=None,
    )

    params = mock_session.execute.call_args[0][1]
    # doc_type must be None so COALESCE preserves the existing DB value
    assert params["doc_type"] is None


@pytest.mark.asyncio
async def test_sync_to_documents_table_partial_ocr_does_not_overwrite_with_other():
    mock_db = MagicMock()
    mock_session = AsyncMock()

    async def mock_session_gen():
        yield mock_session

    mock_db.session.return_value = mock_session_gen()
    repo = JobRepository(mock_db)
    doc_id = uuid.uuid4()

    # Partial OCR with fallback to OTHER_MEDICAL_DOCUMENT
    extracted_data = {
        "status": "partial",
        "documentInfo": {
            "documentType": "OTHER_MEDICAL_DOCUMENT",
        },
    }

    await repo.sync_to_documents_table(
        document_id=doc_id,
        extracted_structured_data=extracted_data,
        raw_ocr_data=None,
    )

    params = mock_session.execute.call_args[0][1]
    assert params["doc_ocr_status"] == "partial"
    # When partial, fallback OTHER_MEDICAL_DOCUMENT must not overwrite existing DB record
    assert params["doc_type"] is None


@pytest.mark.asyncio
async def test_sync_to_documents_table_partial_ocr_preserves_valid_classification():
    mock_db = MagicMock()
    mock_session = AsyncMock()

    async def mock_session_gen():
        yield mock_session

    mock_db.session.return_value = mock_session_gen()
    repo = JobRepository(mock_db)
    doc_id = uuid.uuid4()

    # Partial OCR with a confident classification (e.g. LAB_REPORT)
    extracted_data = {
        "status": "partial",
        "documentInfo": {
            "documentType": "LAB_REPORT",
        },
    }

    await repo.sync_to_documents_table(
        document_id=doc_id,
        extracted_structured_data=extracted_data,
        raw_ocr_data=None,
    )

    params = mock_session.execute.call_args[0][1]
    assert params["doc_ocr_status"] == "partial"
    assert params["doc_type"] == "LAB_REPORT"


@pytest.mark.asyncio
async def test_sync_to_documents_table_retry_updates_with_new_classification():
    mock_db = MagicMock()
    mock_session = AsyncMock()

    async def mock_session_gen():
        yield mock_session

    mock_db.session.return_value = mock_session_gen()
    repo = JobRepository(mock_db)
    doc_id = uuid.uuid4()

    # Retry completes successfully with PRESCRIPTION
    extracted_data = {
        "status": "completed",
        "documentInfo": {
            "documentType": "Rx",
        },
    }

    await repo.sync_to_documents_table(
        document_id=doc_id,
        extracted_structured_data=extracted_data,
        raw_ocr_data=None,
    )

    params = mock_session.execute.call_args[0][1]
    assert params["doc_ocr_status"] == "completed"
    assert params["doc_type"] == "PRESCRIPTION"
