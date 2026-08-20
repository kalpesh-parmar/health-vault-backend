from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.api.v1.routes.validation import router as validation_router
from app.modules.validation.service import MedicalValidationService, InvalidDocumentFileError
from app.settings import Settings


class DummyContainer:
    def __init__(self) -> None:
        self.settings = Settings(
            medgemma_model="medgemma:latest",
            medgemma_fallback="text_classifier",
            medgemma_timeout_ms=5000,
            medgemma_max_pages=3,
            ollama_base_url="http://localhost:11434",
            ai_model="llama3:latest",
            aws_bucket_name="test-bucket",
            gcp_storage_bucket="test-bucket",
        )
        self.storage = AsyncMock()


def create_test_app() -> FastAPI:
    app = FastAPI()
    app.state.container = DummyContainer()
    app.include_router(validation_router, prefix="/v1")
    return app


@pytest.fixture
def client():
    app = create_test_app()
    return TestClient(app)


def make_dummy_image_bytes() -> bytes:
    img = Image.new("RGB", (50, 50), color="white")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_swagger_openapi_schema(client):
    """Verify OpenAPI schema shows ONLY one multipart file field named 'file'."""
    response = client.get("/openapi.json")
    assert response.status_code == 200
    schema = response.json()

    path_item = schema["paths"]["/v1/validation/medical"]["post"]
    request_body = path_item["requestBody"]
    content = request_body["content"]

    assert "multipart/form-data" in content
    multipart_schema = content["multipart/form-data"]["schema"]

    if "$ref" in multipart_schema:
        ref_path = multipart_schema["$ref"].split("/")[1:]
        ref_schema = schema
        for p in ref_path:
            ref_schema = ref_schema[p]
        props = ref_schema.get("properties", {})
    else:
        props = multipart_schema.get("properties", {})

    assert list(props.keys()) == ["file"]


@pytest.mark.asyncio
async def test_empty_file_returns_422(client):
    """Empty file upload should return HTTP 422 with UNREADABLE_FILE error code."""
    response = client.post(
        "/v1/validation/medical",
        files={"file": ("empty.txt", b"", "text/plain")},
    )
    assert response.status_code == 422
    data = response.json()
    assert data["detail"]["code"] == "UNREADABLE_FILE"


@pytest.mark.asyncio
async def test_one_pdf_upload_works(client):
    """Uploading a PDF document works and returns MedicalValidationResponse."""
    img_bytes = make_dummy_image_bytes()

    mock_ollama_resp = {
        "isMedical": True,
        "confidence": 0.95,
        "documentType": "lab_report",
        "reason": "Contains blood test results",
    }

    mock_http_response = MagicMock()
    mock_http_response.status_code = 200
    mock_http_response.json.return_value = {"response": '{"isMedical": true, "confidence": 0.95, "documentType": "lab_report", "reason": "Contains blood test results"}'}

    mock_async_client = AsyncMock()
    mock_async_client.post.return_value = mock_http_response
    mock_async_client.__aenter__.return_value = mock_async_client

    with patch.object(
        MedicalValidationService,
        "is_model_available",
        new_callable=AsyncMock,
        return_value=True,
    ), patch.object(
        MedicalValidationService,
        "_clean_and_parse_json",
        return_value=mock_ollama_resp,
    ), patch(
        "app.modules.validation.service._render_pdf_pages_to_png",
        return_value=[(1, img_bytes)],
    ), patch(
        "httpx.AsyncClient",
        return_value=mock_async_client,
    ):
        response = client.post(
            "/v1/validation/medical",
            files={"file": ("medical-report.pdf", b"%PDF-1.4 dummy", "application/pdf")},
            headers={"x-request-id": "trace-pdf-123"},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["isMedical"] is True
        assert data["confidence"] == 0.95
        assert data["documentType"] == "LAB_REPORT"


@pytest.mark.asyncio
async def test_one_image_upload_works(client):
    """Uploading an image document works and returns MedicalValidationResponse."""
    img_bytes = make_dummy_image_bytes()

    mock_ollama_resp = {
        "isMedical": True,
        "confidence": 0.92,
        "documentType": "prescription",
        "reason": "Medication list visible",
    }

    mock_http_response = MagicMock()
    mock_http_response.status_code = 200
    mock_http_response.json.return_value = {"response": "{}"}

    mock_async_client = AsyncMock()
    mock_async_client.post.return_value = mock_http_response
    mock_async_client.__aenter__.return_value = mock_async_client

    with patch.object(
        MedicalValidationService,
        "is_model_available",
        new_callable=AsyncMock,
        return_value=True,
    ), patch.object(
        MedicalValidationService,
        "_clean_and_parse_json",
        return_value=mock_ollama_resp,
    ), patch(
        "httpx.AsyncClient",
        return_value=mock_async_client,
    ):
        response = client.post(
            "/v1/validation/medical",
            files={"file": ("prescription.jpg", img_bytes, "image/jpeg")},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["isMedical"] is True
        assert data["confidence"] == 0.92
        assert data["documentType"] == "PRESCERIPTION"


@pytest.mark.asyncio
async def test_non_medical_document_identification(client):
    """Non-medical document is correctly identified and returns documentType = null."""
    img_bytes = make_dummy_image_bytes()

    mock_ollama_resp = {
        "isMedical": False,
        "confidence": 0.98,
        "documentType": "receipt",
        "reason": "Grocery receipt",
    }

    mock_http_response = MagicMock()
    mock_http_response.status_code = 200
    mock_http_response.json.return_value = {"response": "{}"}

    mock_async_client = AsyncMock()
    mock_async_client.post.return_value = mock_http_response
    mock_async_client.__aenter__.return_value = mock_async_client

    with patch.object(
        MedicalValidationService,
        "is_model_available",
        new_callable=AsyncMock,
        return_value=True,
    ), patch.object(
        MedicalValidationService,
        "_clean_and_parse_json",
        return_value=mock_ollama_resp,
    ), patch(
        "httpx.AsyncClient",
        return_value=mock_async_client,
    ):
        response = client.post(
            "/v1/validation/medical",
            files={"file": ("receipt.jpg", img_bytes, "image/jpeg")},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["isMedical"] is False
        assert data["documentType"] is None


@pytest.mark.asyncio
async def test_existing_storage_based_validation_unchanged():
    """Verify storage-based validation continues to work when bucket and file_key are passed."""
    container = DummyContainer()
    img_bytes = make_dummy_image_bytes()
    container.storage.read_bytes = AsyncMock(return_value=img_bytes)

    service = MedicalValidationService(container.settings, container.storage)

    mock_ollama_resp = {
        "isMedical": True,
        "confidence": 0.88,
        "documentType": "xray",
        "reason": "Chest X-ray",
    }

    mock_http_response = MagicMock()
    mock_http_response.status_code = 200
    mock_http_response.json.return_value = {"response": "{}"}

    mock_async_client = AsyncMock()
    mock_async_client.post.return_value = mock_http_response
    mock_async_client.__aenter__.return_value = mock_async_client

    with patch.object(
        MedicalValidationService,
        "is_model_available",
        new_callable=AsyncMock,
        return_value=True,
    ), patch.object(
        MedicalValidationService,
        "_clean_and_parse_json",
        return_value=mock_ollama_resp,
    ), patch(
        "httpx.AsyncClient",
        return_value=mock_async_client,
    ):
        result = await service.validate_medical_document(
            bucket="my-bucket",
            file_key="reports/xray.jpg",
            mime_type="image/jpeg",
        )

        assert result.isMedical is True
        assert result.documentType == "IMAGING_REPORT"
        container.storage.read_bytes.assert_called_once_with(
            bucket="my-bucket",
            key="reports/xray.jpg",
        )
