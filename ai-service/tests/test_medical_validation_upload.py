from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient
from PIL import Image

from app.api.v1.routes.validation import router as validation_router
from app.modules.validation.classifier import ClassifierUnavailableError, MedicalDocumentClassifier
from app.modules.validation.service import MedicalValidationService, InvalidDocumentFileError
from app.settings import Settings


class DummyContainer:
    def __init__(self) -> None:
        self.settings = Settings(
            classifier_model_path="models/med-doc-classifier",
            ai_model="llama3:latest",
            ai_base_url="http://localhost:11434",
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
    from PIL import ImageDraw
    img = Image.new("RGB", (200, 200), color="white")
    draw = ImageDraw.Draw(img)
    draw.rectangle([20, 20, 100, 100], fill="black")
    draw.text((30, 30), "Rx Paracetamol 500mg", fill="black")
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

    assert "file" in props
    assert set(props.keys()).issubset({"file", "maxPages", "max_pages"})


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
async def test_one_image_upload_works(client):
    """Uploading an image document works and returns MedicalValidationResponse with documentType = None."""
    img_bytes = make_dummy_image_bytes()

    mock_clf_resp = {
        "is_blank": False,
        "p_medical": 0.96,
        "medical_value": "medical",
        "l2_key": "opd_consultation_record",
        "l2_value": "OPD Consultation Record",
        "p_good": 0.99,
        "handwritten_value": "printed",
    }

    with patch.object(
        MedicalDocumentClassifier,
        "classify_image",
        new_callable=AsyncMock,
        return_value=mock_clf_resp,
    ), patch.object(
        MedicalDocumentClassifier,
        "is_ready",
        return_value=True,
    ):
        response = client.post(
            "/v1/validation/medical",
            files={"file": ("prescription.jpg", img_bytes, "image/jpeg")},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["isMedical"] is True
        assert data["confidence"] == 0.96
        assert data["documentType"] is None  # Always None for contract compatibility!
        assert data["method"] == "classifier"
        assert data["model"] == "ekacare/med-doc-classifier"
        assert data["metrics"]["used_ollama"] is False


@pytest.mark.asyncio
async def test_non_medical_document_identification(client):
    """Non-medical document is correctly identified and returns documentType = None."""
    img_bytes = make_dummy_image_bytes()

    mock_clf_resp = {
        "is_blank": False,
        "p_medical": 0.05,
        "medical_value": "non_medical",
        "l2_key": "aadhaar_card",
        "l2_value": "Aadhaar Card",
        "p_good": 0.95,
        "handwritten_value": "printed",
    }

    with patch.object(
        MedicalDocumentClassifier,
        "classify_image",
        new_callable=AsyncMock,
        return_value=mock_clf_resp,
    ), patch.object(
        MedicalDocumentClassifier,
        "is_ready",
        return_value=True,
    ):
        response = client.post(
            "/v1/validation/medical",
            files={"file": ("aadhaar.jpg", img_bytes, "image/jpeg")},
        )

        assert response.status_code == 200
        data = response.json()
        assert data["isMedical"] is False
        assert data["documentType"] is None
        assert data["method"] == "classifier"
        assert data["metrics"]["used_ollama"] is False


@pytest.mark.asyncio
async def test_classifier_unavailable_returns_503(client):
    """When classifier is unavailable, endpoint returns HTTP 503 CLASSIFIER_UNAVAILABLE."""
    img_bytes = make_dummy_image_bytes()

    with patch.object(
        MedicalValidationService,
        "validate_medical_document",
        side_effect=ClassifierUnavailableError("Model weights not found"),
    ):
        response = client.post(
            "/v1/validation/medical",
            files={"file": ("report.jpg", img_bytes, "image/jpeg")},
        )

        assert response.status_code == 503
        data = response.json()
        assert data["detail"]["code"] == "CLASSIFIER_UNAVAILABLE"
        assert data["detail"]["alias"] == "MEDGEMMA_UNAVAILABLE"


@pytest.mark.asyncio
async def test_existing_storage_based_validation_unchanged():
    """Verify storage-based validation continues to work when bucket and file_key are passed."""
    container = DummyContainer()
    img_bytes = make_dummy_image_bytes()
    container.storage.read_bytes = AsyncMock(return_value=img_bytes)

    service = MedicalValidationService(container.settings, container.storage)

    mock_clf_resp = {
        "is_blank": False,
        "p_medical": 0.92,
        "medical_value": "medical",
        "l2_key": "x_ray",
        "l2_value": "X-ray",
        "p_good": 0.90,
        "handwritten_value": "printed",
    }

    with patch.object(
        MedicalDocumentClassifier,
        "classify_image",
        new_callable=AsyncMock,
        return_value=mock_clf_resp,
    ), patch.object(
        MedicalDocumentClassifier,
        "is_ready",
        return_value=True,
    ):
        result = await service.validate_medical_document(
            bucket="my-bucket",
            file_key="reports/xray.jpg",
            mime_type="image/jpeg",
        )

        assert result.isMedical is True
        assert result.documentType is None  # Always None!
        assert result.method == "classifier"
        assert result.metrics.used_ollama is False
        container.storage.read_bytes.assert_called_once_with(
            bucket="my-bucket",
            key="reports/xray.jpg",
        )
