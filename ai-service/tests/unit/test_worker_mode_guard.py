from __future__ import annotations

import os
import pytest

from app.core.lifecycle import detect_uvicorn_worker_count, validate_worker_mode_configuration
from app.settings import Settings


@pytest.fixture
def base_settings():
    return Settings(
        database_url="postgresql+asyncpg://postgres:postgres@localhost:5432/health_vault_test",
        ai_model="test-model",
        ai_base_url="http://localhost:11434",
        internal_service_key="secret-key-123",
        patient_documents_bucket="test-bucket",
        aws_region="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        worker_mode="standalone",
    )


def test_default_standalone_mode_allows_multiple_uvicorn_workers(base_settings):
    # Standalone worker mode must allow any number of Uvicorn workers without raising error
    base_settings.worker_mode = "standalone"
    validate_worker_mode_configuration(base_settings, worker_count=4)
    validate_worker_mode_configuration(base_settings, worker_count=8)


def test_in_process_mode_allowed_with_single_worker(base_settings):
    base_settings.worker_mode = "in_process"
    validate_worker_mode_configuration(base_settings, worker_count=1)


def test_in_process_mode_prohibited_with_multiple_uvicorn_workers(base_settings):
    base_settings.worker_mode = "in_process"
    with pytest.raises(RuntimeError) as exc_info:
        validate_worker_mode_configuration(base_settings, worker_count=4)
    assert "WORKER_MODE='in_process' is prohibited with multi-worker Uvicorn" in str(exc_info.value)
    assert "4 workers" in str(exc_info.value)


def test_detect_uvicorn_worker_count_from_env(monkeypatch):
    monkeypatch.setenv("WEB_CONCURRENCY", "3")
    assert detect_uvicorn_worker_count() == 3

    monkeypatch.delenv("WEB_CONCURRENCY")
    monkeypatch.setenv("UVICORN_WORKERS", "5")
    assert detect_uvicorn_worker_count() == 5
