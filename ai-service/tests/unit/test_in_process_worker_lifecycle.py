from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from fastapi import FastAPI

from app.core.lifecycle import lifespan
from app.settings import Settings


@pytest.fixture
def mock_app():
    return FastAPI()


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
        worker_mode="in_process",
    )


@pytest.mark.asyncio
async def test_in_process_worker_lifecycle_starts_and_stops_runner(mock_app, base_settings):
    base_settings.worker_mode = "in_process"

    mock_runner_instance = MagicMock()
    mock_runner_instance.start = AsyncMock()
    mock_runner_instance.stop = AsyncMock()

    mock_container = MagicMock()
    mock_container.start = AsyncMock()
    mock_container.stop = AsyncMock()
    mock_container.db = MagicMock()
    mock_container.pipeline_orchestrator.process_job = AsyncMock()

    with (
        patch("app.core.lifecycle.get_settings", return_value=base_settings),
        patch("app.core.lifecycle.Container", return_value=mock_container),
        patch("app.workers.runner.WorkerRunner", return_value=mock_runner_instance) as mock_runner_cls,
    ):
        async with lifespan(mock_app):
            mock_container.start.assert_awaited_once()
            mock_runner_cls.assert_called_once_with(
                mock_container.db,
                base_settings,
                job_handler=mock_container.pipeline_orchestrator.process_job,
            )
            mock_runner_instance.start.assert_awaited_once()
            assert mock_app.state.worker_runner is mock_runner_instance

        mock_runner_instance.stop.assert_awaited_once()
        mock_container.stop.assert_awaited_once()


@pytest.mark.asyncio
async def test_standalone_mode_does_not_start_in_process_runner(mock_app, base_settings):
    base_settings.worker_mode = "standalone"

    mock_container = MagicMock()
    mock_container.start = AsyncMock()
    mock_container.stop = AsyncMock()

    with (
        patch("app.core.lifecycle.get_settings", return_value=base_settings),
        patch("app.core.lifecycle.Container", return_value=mock_container),
        patch("app.workers.runner.WorkerRunner") as mock_runner_cls,
    ):
        async with lifespan(mock_app):
            mock_container.start.assert_awaited_once()
            mock_runner_cls.assert_not_called()
            assert getattr(mock_app.state, "worker_runner", None) is None

        mock_container.stop.assert_awaited_once()
