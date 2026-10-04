from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.settings import Settings
from app.workers.runner import WorkerRunner


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
        worker_poll_interval_seconds=0.05,
        worker_heartbeat_interval_seconds=0.05,
        worker_heartbeat_stale_seconds=0.2,
    )


@pytest.mark.asyncio
async def test_worker_runner_start_and_graceful_stop(mock_settings):
    db = MagicMock()
    processed_jobs = []

    async def dummy_handler(job):
        processed_jobs.append(job["id"])

    runner = WorkerRunner(db, mock_settings, job_handler=dummy_handler)
    runner.claimer.claim_next = AsyncMock(return_value=None)
    runner.reconciler.start = AsyncMock()
    runner.reconciler.stop = AsyncMock()

    await runner.start()
    await asyncio.sleep(0.08)
    await runner.stop()

    runner.reconciler.start.assert_awaited_once()
    runner.reconciler.stop.assert_awaited_once()
    assert runner.stopping is True
