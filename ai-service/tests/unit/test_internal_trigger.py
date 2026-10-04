from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, patch

import pytest
from fastapi.testclient import TestClient

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.v1.routes.internal_documents import router as internal_router
from app.settings import Settings, get_settings


@pytest.fixture
def mock_settings():
    return Settings(
        database_url="postgresql+asyncpg://postgres:postgres@localhost:5432/health_vault_test",
        ai_model="test-model",
        ai_base_url="http://localhost:11434",
        internal_service_key="secret-key-123",
        patient_documents_bucket="test-bucket",
        aws_region="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
    )


@pytest.fixture
def client(mock_settings):
    app = FastAPI()
    app.dependency_overrides[get_settings] = lambda: mock_settings
    app.include_router(internal_router)
    return TestClient(app)


def test_trigger_missing_auth_returns_401(client):
    job_id = str(uuid.uuid4())
    payload = {
        "jobId": job_id,
        "patientId": str(uuid.uuid4()),
        "documentId": str(uuid.uuid4()),
        "storage": {
            "bucket": "test-bucket",
            "key": "test/path.pdf",
            "sha256": "abc123",
        },
    }
    response = client.post("/internal/documents/process", json=payload)
    assert response.status_code == 401
    assert "Missing required X-Internal-Service-Key" in response.json()["detail"]


def test_trigger_invalid_auth_returns_401(client):
    job_id = str(uuid.uuid4())
    payload = {
        "jobId": job_id,
        "patientId": str(uuid.uuid4()),
        "documentId": str(uuid.uuid4()),
        "storage": {
            "bucket": "test-bucket",
            "key": "test/path.pdf",
            "sha256": "abc123",
        },
    }
    headers = {"X-Internal-Service-Key": "wrong-key"}
    response = client.post("/internal/documents/process", json=payload, headers=headers)
    assert response.status_code == 401
    assert "Invalid internal service key" in response.json()["detail"]


def test_trigger_non_existent_job_returns_404(client):
    job_id = str(uuid.uuid4())
    payload = {
        "jobId": job_id,
        "patientId": str(uuid.uuid4()),
        "documentId": str(uuid.uuid4()),
        "storage": {
            "bucket": "test-bucket",
            "key": "test/path.pdf",
            "sha256": "abc123",
        },
    }
    headers = {"X-Internal-Service-Key": "secret-key-123"}
    with patch("app.api.v1.routes.internal_documents.JobRepository.get_job_by_id", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = None
        response = client.post("/internal/documents/process", json=payload, headers=headers)
        assert response.status_code == 404


def test_trigger_valid_queued_job_returns_202(client):
    job_id = str(uuid.uuid4())
    payload = {
        "jobId": job_id,
        "patientId": str(uuid.uuid4()),
        "documentId": str(uuid.uuid4()),
        "storage": {
            "bucket": "test-bucket",
            "key": "test/path.pdf",
            "sha256": "abc123",
        },
    }
    headers = {"X-Internal-Service-Key": "secret-key-123"}
    with patch("app.api.v1.routes.internal_documents.JobRepository.get_job_by_id", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = {"id": job_id, "status": "QUEUED"}
        response = client.post("/internal/documents/process", json=payload, headers=headers)
        assert response.status_code == 202
        data = response.json()
        assert data["jobId"] == job_id
        assert data["status"] == "QUEUED"


def test_trigger_already_running_job_returns_202_without_re_enqueue(client):
    job_id = str(uuid.uuid4())
    payload = {
        "jobId": job_id,
        "patientId": str(uuid.uuid4()),
        "documentId": str(uuid.uuid4()),
        "storage": {
            "bucket": "test-bucket",
            "key": "test/path.pdf",
            "sha256": "abc123",
        },
    }
    headers = {"X-Internal-Service-Key": "secret-key-123"}
    with patch("app.api.v1.routes.internal_documents.JobRepository.get_job_by_id", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = {"id": job_id, "status": "RUNNING"}
        response = client.post("/internal/documents/process", json=payload, headers=headers)
        assert response.status_code == 202
        data = response.json()
        assert data["jobId"] == job_id
        assert data["status"] == "RUNNING"


def test_trigger_completed_job_returns_200(client):
    job_id = str(uuid.uuid4())
    payload = {
        "jobId": job_id,
        "patientId": str(uuid.uuid4()),
        "documentId": str(uuid.uuid4()),
        "storage": {
            "bucket": "test-bucket",
            "key": "test/path.pdf",
            "sha256": "abc123",
        },
    }
    headers = {"X-Internal-Service-Key": "secret-key-123"}
    with patch("app.api.v1.routes.internal_documents.JobRepository.get_job_by_id", new_callable=AsyncMock) as mock_get:
        mock_get.return_value = {"id": job_id, "status": "COMPLETED"}
        response = client.post("/internal/documents/process", json=payload, headers=headers)
        assert response.status_code == 200
        data = response.json()
        assert data["jobId"] == job_id
        assert data["status"] == "COMPLETED"
