from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.routes.health import router as health_router


@pytest.fixture
def mock_container():
    container = MagicMock()
    container.settings = MagicMock()
    container.settings.ai_model = "test-model"
    container.settings.effective_gcp_bucket = "test-bucket"
    container.settings.patient_documents_bucket = "test-bucket"
    container.storage_provider = "s3"

    # Mock DB session
    session_cm = AsyncMock()
    session = AsyncMock()
    session.execute = AsyncMock()
    session_cm.__aenter__.return_value = session
    session_cm.__aexit__.return_value = None
    container.db.session_factory.return_value = session_cm

    # Mock LLM health
    container.llm.health = AsyncMock(return_value={"status": "ok", "provider": "ollama"})

    # Mock legacy OCR status
    container.ocr.status.return_value = {"status": "ready"}

    # Mock embeddings
    container.models.embeddings.is_ready = True
    container.models.embeddings.model_name = "bge-m3"
    container.models.embeddings.expected_dim = 1024

    return container


def create_test_client(container: MagicMock) -> TestClient:
    app = FastAPI()
    app.state.container = container
    app.include_router(health_router)
    return TestClient(app)


def test_health_reports_paddleocr_available(mock_container):
    """Verify /health returns available=True and error=None when PaddleOCR is healthy."""
    paddle_mock = MagicMock()
    paddle_mock.is_available.return_value = True
    paddle_mock._init_error = None
    paddle_mock.device = "cpu"
    paddle_mock.enable_mkldnn = False
    mock_container.paddle_ocr = paddle_mock

    client = create_test_client(mock_container)
    resp = client.get("/health")

    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert "engines" in data
    assert "paddleocr" in data["engines"]

    paddle_info = data["engines"]["paddleocr"]
    assert paddle_info["available"] is True
    assert paddle_info["error"] is None
    assert paddle_info["device"] == "cpu"
    assert paddle_info["mkldnn"] is False


def test_health_reports_paddleocr_failure(mock_container):
    """Verify /health returns available=False and the error string when PaddleOCR failed init."""
    paddle_mock = MagicMock()
    paddle_mock.is_available.return_value = False
    paddle_mock._init_error = RuntimeError("OneDNN ConvertPirAttribute2RuntimeAttribute error")
    paddle_mock.device = "unknown"
    paddle_mock.enable_mkldnn = True
    mock_container.paddle_ocr = paddle_mock

    client = create_test_client(mock_container)
    resp = client.get("/health")

    assert resp.status_code == 200
    data = resp.json()
    assert data["success"] is True
    assert "engines" in data
    assert "paddleocr" in data["engines"]

    paddle_info = data["engines"]["paddleocr"]
    assert paddle_info["available"] is False
    assert "ConvertPirAttribute2RuntimeAttribute" in paddle_info["error"]
    assert paddle_info["device"] == "unknown"
    assert paddle_info["mkldnn"] is True


def test_health_handles_missing_paddleocr_attribute(mock_container):
    """Verify /health does not raise AttributeError if paddle_ocr is not set."""
    mock_container.paddle_ocr = None

    client = create_test_client(mock_container)
    resp = client.get("/health")

    assert resp.status_code == 200
    data = resp.json()
    assert data["engines"]["paddleocr"]["available"] is False
    assert data["engines"]["paddleocr"]["error"] is None
