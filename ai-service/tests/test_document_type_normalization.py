from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from app.modules.validation.service import (
    MedicalValidationService,
    ALLOWED_DOCUMENT_TYPES,
)
from app.settings import Settings


@pytest.fixture
def service():
    settings = Settings(
        medgemma_model="medgemma:latest",
        medgemma_fallback="text_classifier",
        medgemma_timeout_ms=5000,
        medgemma_max_pages=3,
        ollama_base_url="http://localhost:11434",
        ai_model="llama3:latest",
        aws_bucket_name="test-bucket",
        gcp_storage_bucket="test-bucket",
    )
    storage = AsyncMock()
    return MedicalValidationService(settings, storage)


def test_allowed_document_types_count(service):
    assert len(ALLOWED_DOCUMENT_TYPES) == 9
    assert ALLOWED_DOCUMENT_TYPES == {
        "PRESCERIPTION",
        "LAB_REPORT",
        "IMAGING_REPORT",
        "DISCHARGE_SUMMARY",
        "CONSULTATION_REPORT",
        "SURGERY_PROCEDURE_REPORT",
        "VACCINATION_RECORD",
        "MEDICAL_CERTIFICATE",
        "OTHER_MEDICAL_DOCUMENT",
    }


@pytest.mark.parametrize(
    "raw_input,expected",
    [
        ("X-ray / MRI / CT Scan report", "IMAGING_REPORT"),
        ("x-ray", "IMAGING_REPORT"),
        ("MRI report", "IMAGING_REPORT"),
        ("CBC Report", "LAB_REPORT"),
        ("blood_report", "LAB_REPORT"),
        ("Prescription", "PRESCERIPTION"),
        ("Doctor Note", "CONSULTATION_REPORT"),
        ("Discharge Summary", "DISCHARGE_SUMMARY"),
        ("Surgery Report", "SURGERY_PROCEDURE_REPORT"),
        ("Vaccination Record", "VACCINATION_RECORD"),
        ("Medical Certificate", "MEDICAL_CERTIFICATE"),
        ("unknown medical type", "OTHER_MEDICAL_DOCUMENT"),
        ("random string 123", "OTHER_MEDICAL_DOCUMENT"),
        ("ECG chart", "OTHER_MEDICAL_DOCUMENT"),
        ("IMAGING_REPORT", "IMAGING_REPORT"),
        ("PRESCERIPTION", "PRESCERIPTION"),
    ],
)
def test_normalize_document_type_medical_cases(service, raw_input, expected):
    res = service._normalize_document_type(raw_input, is_medical=True)
    assert res == expected
    assert res in ALLOWED_DOCUMENT_TYPES


def test_normalize_document_type_non_medical(service):
    res = service._normalize_document_type("Prescription", is_medical=False)
    assert res is None


@pytest.mark.asyncio
async def test_parse_failure_does_not_become_medical(service):
    mock_http_response = MagicMock()
    mock_http_response.status_code = 200
    mock_http_response.json.return_value = {"response": "INVALID JSON OUTPUT"}

    mock_async_client = AsyncMock()
    mock_async_client.post.return_value = mock_http_response
    mock_async_client.__aenter__.return_value = mock_async_client

    with patch.object(service, "is_model_available", return_value=True), patch.object(
        service, "_downscale_image", return_value=b"dummy"
    ), patch("httpx.AsyncClient", return_value=mock_async_client):
        res = await service.validate_medical_document(
            file_bytes=b"dummy", file_name="doc.jpg"
        )
        assert res.isMedical is False
        assert res.documentType is None
        assert res.confidence == 0.0
