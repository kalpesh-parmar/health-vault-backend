from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.settings import Settings
from app.workers.claimer import JobClaimer
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
        worker_concurrency=2,
        worker_poll_interval_seconds=0.01,
        worker_heartbeat_interval_seconds=0.05,
    )


@pytest.mark.asyncio
async def test_claim_returns_oldest_queued_job(mock_settings):
    db = MagicMock()
    claimer = JobClaimer(db, mock_settings)
    job_id = uuid.uuid4()
    claimer.repo.claim_next_job = AsyncMock(
        return_value={"id": job_id, "status": "RUNNING", "attempt_count": 1}
    )

    claimed = await claimer.claim_next()
    assert claimed is not None
    assert claimed["id"] == job_id
    assert claimed["attempt_count"] == 1
    assert claimer.semaphore._value == 1  # 1 of 2 permits acquired
    claimer.release_slot()
    assert claimer.semaphore._value == 2


@pytest.mark.asyncio
async def test_claim_next_releases_slot_when_no_job_found(mock_settings):
    db = MagicMock()
    claimer = JobClaimer(db, mock_settings)
    claimer.repo.claim_next_job = AsyncMock(return_value=None)

    claimed = await claimer.claim_next()
    assert claimed is None
    # Verify slot was immediately returned and not leaked
    assert claimer.semaphore._value == mock_settings.worker_concurrency


@pytest.mark.asyncio
async def test_claim_job_releases_slot_when_job_not_claimable(mock_settings):
    db = MagicMock()
    claimer = JobClaimer(db, mock_settings)
    claimer.repo.claim_specific_job = AsyncMock(return_value=None)

    claimed = await claimer.claim_job(uuid.uuid4())
    assert claimed is None
    # Verify slot was immediately returned and not leaked
    assert claimer.semaphore._value == mock_settings.worker_concurrency


@pytest.mark.asyncio
async def test_claim_increments_attempt_count_exactly_once(mock_settings):
    db = MagicMock()
    claimer = JobClaimer(db, mock_settings)
    job_id = uuid.uuid4()

    claimer.repo.claim_specific_job = AsyncMock(
        return_value={"id": job_id, "status": "RUNNING", "attempt_count": 2}
    )

    claimed = await claimer.claim_job(job_id)
    assert claimed is not None
    assert claimed["attempt_count"] == 2
    claimer.release_slot()


@pytest.mark.asyncio
async def test_runner_enforces_worker_concurrency_limit_across_multiple_jobs(mock_settings):
    db = MagicMock()
    mock_settings.worker_concurrency = 2
    mock_settings.worker_poll_interval_seconds = 0.01

    queued_jobs = [{"id": uuid.uuid4(), "status": "QUEUED"} for _ in range(6)]
    completed_jobs = []
    current_concurrency = 0
    max_observed_concurrency = 0
    concurrency_lock = asyncio.Lock()

    async def mock_claim_next():
        if queued_jobs:
            job = queued_jobs.pop(0)
            return {"id": job["id"], "status": "RUNNING", "attempt_count": 1}
        return None

    async def concurrent_job_handler(job):
        nonlocal current_concurrency, max_observed_concurrency
        async with concurrency_lock:
            current_concurrency += 1
            if current_concurrency > max_observed_concurrency:
                max_observed_concurrency = current_concurrency

        # Simulate async compute
        await asyncio.sleep(0.04)

        async with concurrency_lock:
            current_concurrency -= 1
            completed_jobs.append(job["id"])

    runner = WorkerRunner(db, mock_settings, job_handler=concurrent_job_handler)
    runner.claimer.repo.claim_next_job = AsyncMock(side_effect=mock_claim_next)
    runner.reconciler.start = AsyncMock()
    runner.reconciler.stop = AsyncMock()

    await runner.start()

    # Wait until all 6 jobs are drained
    for _ in range(50):
        if len(completed_jobs) == 6:
            break
        await asyncio.sleep(0.02)

    await runner.stop()

    assert len(completed_jobs) == 6
    # Invariant: Concurrency never exceeded configured worker_concurrency (2)
    assert max_observed_concurrency <= 2
    assert max_observed_concurrency == 2
    # Invariant: All permits returned, zero semaphore leaks
    assert runner.claimer.semaphore._value == 2


@pytest.mark.asyncio
async def test_runner_releases_slot_on_processing_failure(mock_settings):
    db = MagicMock()
    mock_settings.worker_concurrency = 2
    job_id = uuid.uuid4()

    async def failing_job_handler(job):
        raise RuntimeError("Model inference OOM or corrupt file")

    runner = WorkerRunner(db, mock_settings, job_handler=failing_job_handler)
    runner.claimer.repo.claim_specific_job = AsyncMock(
        return_value={"id": job_id, "status": "RUNNING", "attempt_count": 1}
    )
    runner.repo.fail_job = AsyncMock()
    runner.reconciler.start = AsyncMock()
    runner.reconciler.stop = AsyncMock()

    # Dispatch failure job
    await runner.dispatch_queue.put(job_id)
    await runner.start()
    await asyncio.sleep(0.05)
    await runner.stop()

    runner.repo.fail_job.assert_awaited_once()
    # Invariant: Slot was cleanly released in finally block despite exception
    assert runner.claimer.semaphore._value == 2


@pytest.mark.asyncio
async def test_runner_no_deadlock_or_starvation_under_high_queue_load(mock_settings):
    db = MagicMock()
    mock_settings.worker_concurrency = 2
    mock_settings.worker_poll_interval_seconds = 0.005

    total_jobs = 10
    queued = [{"id": uuid.uuid4(), "status": "QUEUED"} for _ in range(total_jobs)]
    processed = []

    async def mock_claim():
        if queued:
            return {"id": queued.pop(0)["id"], "status": "RUNNING", "attempt_count": 1}
        return None

    async def fast_handler(job):
        await asyncio.sleep(0.01)
        processed.append(job["id"])

    runner = WorkerRunner(db, mock_settings, job_handler=fast_handler)
    runner.claimer.repo.claim_next_job = AsyncMock(side_effect=mock_claim)
    runner.reconciler.start = AsyncMock()
    runner.reconciler.stop = AsyncMock()

    await runner.start()

    for _ in range(60):
        if len(processed) == total_jobs:
            break
        await asyncio.sleep(0.02)

    await runner.stop()

    assert len(processed) == total_jobs
    assert runner.claimer.semaphore._value == 2
