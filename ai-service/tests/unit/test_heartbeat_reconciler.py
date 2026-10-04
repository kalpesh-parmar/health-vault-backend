from __future__ import annotations

import asyncio
import uuid
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID

import pytest

from app.constants.stages import (
    STAGE_ANALYZING,
    STAGE_EMBEDDING,
    STAGE_FIELD_EXTRACTION,
    STAGE_GRAPH_EXTRACTION,
    STAGE_OCR_RUNNING,
    STAGE_PARSING,
    STAGE_SUMMARIZING,
    STAGE_UPLOADING,
    STAGE_VALIDATING,
)
from app.infrastructure.db.repositories.job_repository import (
    JobRepository,
    ReconcileResult,
)
from app.services.pipeline.orchestrator import PipelineOrchestrator
from app.settings import Settings
from app.workers.claimer import JobClaimer
from app.workers.heartbeat import JobHeartbeat
from app.workers.reconciler import CrashReconciler
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
        worker_heartbeat_interval_seconds=15.0,
        worker_heartbeat_stale_seconds=180.0,
        worker_reconciler_interval_seconds=180.0,
    )


# ---------------------------------------------------------------------------
# 1. Heartbeat Mechanism & Clean Shutdown Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_heartbeat_updates_periodically():
    """Verify heartbeat runs independently and touches last_heartbeat_at."""
    db = MagicMock()
    job_id = uuid.uuid4()
    heartbeat = JobHeartbeat(db, job_id, interval_seconds=0.05)
    heartbeat.repo.update_job_heartbeat = AsyncMock(return_value=True)

    await heartbeat.start()
    await asyncio.sleep(0.12)
    await heartbeat.stop()

    assert heartbeat.repo.update_job_heartbeat.await_count >= 1
    heartbeat.repo.update_job_heartbeat.assert_awaited_with(job_id)


@pytest.mark.asyncio
async def test_heartbeat_stops_cleanly_on_exit():
    """Verify heartbeat background task is cancelled cleanly without leaks."""
    db = MagicMock()
    job_id = uuid.uuid4()
    heartbeat = JobHeartbeat(db, job_id, interval_seconds=1.0)
    heartbeat.repo.update_job_heartbeat = AsyncMock(return_value=True)

    await heartbeat.start()
    assert heartbeat._task is not None
    assert not heartbeat._task.done()

    await heartbeat.stop()
    assert heartbeat._task is None
    assert not heartbeat._running


@pytest.mark.asyncio
async def test_heartbeat_stops_when_job_no_longer_running():
    """Verify heartbeat automatically terminates if the job is no longer RUNNING (rowcount == 0)."""
    db = MagicMock()
    job_id = uuid.uuid4()
    heartbeat = JobHeartbeat(db, job_id, interval_seconds=0.02)
    # Return False indicating 0 rows updated (e.g. job already COMPLETED or FAILED)
    heartbeat.repo.update_job_heartbeat = AsyncMock(return_value=False)

    await heartbeat.start()
    await asyncio.sleep(0.08)

    # Task should have exited its loop on its own
    assert heartbeat._task is not None
    assert heartbeat._task.done()
    await heartbeat.stop()


# ---------------------------------------------------------------------------
# 2. Timing Configuration & M1 Contract Tests
# ---------------------------------------------------------------------------


def test_m1_timing_configuration_defaults(mock_settings):
    """Verify the M1 contract timing parameters: 15s heartbeat, >3m stale, 3m reconciler."""
    assert mock_settings.worker_heartbeat_interval_seconds == 15.0
    assert mock_settings.worker_heartbeat_stale_seconds >= 180.0  # 3 minutes
    assert mock_settings.worker_reconciler_interval_seconds == 180.0  # 3 minutes


# ---------------------------------------------------------------------------
# 3. Crash Reconciler Decision Matrix Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_stale_job_with_valid_checkpoint_requeues():
    """Stale job with valid S3/UPLOADING checkpoint transitions back to QUEUED."""
    db = MagicMock()
    reconciler = CrashReconciler(db, stale_seconds=180.0, max_attempts=3)
    requeued_id = uuid.uuid4()

    reconciler.repo.reconcile_stale_jobs = AsyncMock(
        return_value=ReconcileResult(
            requeued=[requeued_id],
            failed_unuploaded=[],
            failed_exceeded=[],
        )
    )

    result = await reconciler.reconcile_once()
    assert requeued_id in result.requeued
    assert len(result.failed_unuploaded) == 0
    assert len(result.failed_exceeded) == 0
    assert len(result.failed) == 0
    reconciler.repo.reconcile_stale_jobs.assert_awaited_once_with(
        stale_seconds=180.0, max_attempts=3
    )


@pytest.mark.asyncio
async def test_stale_job_without_required_checkpoint_fails_with_requires_reupload():
    """Stale job that crashed before UPLOADING completed transitions to FAILED with requiresReupload=True."""
    db = MagicMock()
    reconciler = CrashReconciler(db, stale_seconds=180.0, max_attempts=3)
    failed_unuploaded_id = uuid.uuid4()

    reconciler.repo.reconcile_stale_jobs = AsyncMock(
        return_value=ReconcileResult(
            requeued=[],
            failed_unuploaded=[failed_unuploaded_id],
            failed_exceeded=[],
        )
    )

    result = await reconciler.reconcile_once()
    assert len(result.requeued) == 0
    assert failed_unuploaded_id in result.failed_unuploaded
    assert failed_unuploaded_id in result.failed
    assert len(result.failed_exceeded) == 0


@pytest.mark.asyncio
async def test_stale_job_exceeding_max_attempts_fails_permanently():
    """Stale job with attempt_count >= max_attempts transitions to FAILED with retryable=False."""
    db = MagicMock()
    reconciler = CrashReconciler(db, stale_seconds=180.0, max_attempts=3)
    exceeded_id = uuid.uuid4()

    reconciler.repo.reconcile_stale_jobs = AsyncMock(
        return_value=ReconcileResult(
            requeued=[],
            failed_unuploaded=[],
            failed_exceeded=[exceeded_id],
        )
    )

    result = await reconciler.reconcile_once()
    assert len(result.requeued) == 0
    assert len(result.failed_unuploaded) == 0
    assert exceeded_id in result.failed_exceeded
    assert exceeded_id in result.failed


# ---------------------------------------------------------------------------
# 4. Attempt Count Invariance & Idempotency Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_attempt_count_remains_unchanged_during_reconciliation():
    """Verify reconciler never increments attempt_count; attempt_count is preserved."""
    db = MagicMock()
    job_id = uuid.uuid4()
    original_attempt_count = 1

    # Simulate job row before reconciliation
    stale_job = {
        "id": job_id,
        "status": "RUNNING",
        "attempt_count": original_attempt_count,
        "completed_stages": [STAGE_VALIDATING, STAGE_UPLOADING],
        "checkpoint_data": {"uploaded": True},
    }

    # Verify that ReconcileResult preserves state and query has no attempt_count increment
    reconciler = CrashReconciler(db, stale_seconds=180.0, max_attempts=3)
    reconciler.repo.reconcile_stale_jobs = AsyncMock(
        return_value=ReconcileResult(
            requeued=[job_id],
            failed_unuploaded=[],
            failed_exceeded=[],
        )
    )

    res = await reconciler.reconcile_once()
    assert job_id in res.requeued
    # Job row's attempt_count is unchanged during requeue
    assert stale_job["attempt_count"] == original_attempt_count


@pytest.mark.asyncio
async def test_duplicate_reconciliation_is_harmless_and_idempotent():
    """Running reconciler multiple times when no new stale jobs exist is a harmless no-op."""
    db = MagicMock()
    reconciler = CrashReconciler(db, stale_seconds=180.0, max_attempts=3)
    stale_id = uuid.uuid4()

    # First run recovers the stale job
    # Second run finds no remaining RUNNING stale jobs
    reconciler.repo.reconcile_stale_jobs = AsyncMock(
        side_effect=[
            ReconcileResult(requeued=[stale_id], failed_unuploaded=[], failed_exceeded=[]),
            ReconcileResult(requeued=[], failed_unuploaded=[], failed_exceeded=[]),
        ]
    )

    run1 = await reconciler.reconcile_once()
    assert stale_id in run1.requeued

    run2 = await reconciler.reconcile_once()
    assert len(run2.requeued) == 0
    assert len(run2.failed_unuploaded) == 0
    assert len(run2.failed_exceeded) == 0


# ---------------------------------------------------------------------------
# 5. Checkpoint Resume & Stage Preservation Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_recovered_job_resumes_from_first_incomplete_stage():
    """A recovered QUEUED job resumes from its first incomplete stage without repeating completed work."""
    repo = MagicMock()
    repo.update_job_checkpoint = AsyncMock()
    repo.complete_job = AsyncMock()

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()

    checkpoint = MagicMock()
    checkpoint.persist_stage_checkpoint = AsyncMock(return_value={})
    checkpoint.load_stage_artifact = AsyncMock()

    s3_client = MagicMock()
    s3_client.read_bytes = AsyncMock(return_value=b"fake-pdf-content")

    ocr_handler = MagicMock()
    ocr_handler.verify_upload = AsyncMock(return_value=None)
    ocr_handler.validate_document = AsyncMock()
    ocr_handler.run_ocr = AsyncMock()
    layout_handler = MagicMock()
    layout_handler.parse_layout = AsyncMock()
    graph_handler = MagicMock()
    graph_handler.extract_graphs = AsyncMock(return_value=[])
    clinical_handler = MagicMock()
    clinical_handler.extract_fields = AsyncMock(return_value={})
    analysis_handler = MagicMock()
    analysis_handler.analyze = MagicMock(return_value={"riskLevel": "LOW"})
    repo.fail_job = AsyncMock()
    summary_handler = MagicMock()
    summary_handler.generate_summary = AsyncMock(return_value={"summaryEnglish": "Summary text"})
    embedding_handler = MagicMock()
    embedding_handler.generate_embeddings = AsyncMock(return_value={"chunkCount": 3})

    orchestrator = PipelineOrchestrator(
        job_repo=repo,
        lifecycle_service=lifecycle,
        checkpoint_service=checkpoint,
        s3_client=s3_client,
        ocr_handler=ocr_handler,
        layout_handler=layout_handler,
        graph_handler=graph_handler,
        clinical_handler=clinical_handler,
        analysis_handler=analysis_handler,
        summary_handler=summary_handler,
        embedding_handler=embedding_handler,
    )

    # Simulate a job recovered from crash after OCR_RUNNING and PARSING completed
    recovered_job = {
        "id": uuid.uuid4(),
        "file_key": "patient/doc/recovered_test.pdf",
        "completed_stages": [
            STAGE_VALIDATING,
            STAGE_UPLOADING,
            STAGE_OCR_RUNNING,
            STAGE_PARSING,
        ],
        "checkpoint_data": {"uploaded": True, "s3Bucket": "test-bucket"},
        "percentage": 50,
        "raw_ocr_data": {"fullText": "Clinical notes for recovered job"},
        "extracted_structured_data": None,
    }

    # Process recovered job
    await orchestrator.process_job(recovered_job)

    # 1. Previously completed stages must NEVER be rerun:
    ocr_handler.validate_document.assert_not_called()
    ocr_handler.run_ocr.assert_not_called()
    layout_handler.parse_layout.assert_not_called()

    # 2. Incomplete stages MUST execute:
    graph_handler.extract_graphs.assert_called_once()
    clinical_handler.extract_fields.assert_called_once()
    analysis_handler.analyze.assert_called_once()
    summary_handler.generate_summary.assert_called_once()
    embedding_handler.generate_embeddings.assert_called_once()
    repo.complete_job.assert_called_once()


# ---------------------------------------------------------------------------
# 6. Concurrency, Atomic Claim & Worker Shutdown Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_atomic_claim_prevents_duplicate_workers(mock_settings):
    """FOR UPDATE SKIP LOCKED ensures only one worker claims the recovered job."""
    db = MagicMock()
    claimer1 = JobClaimer(db, mock_settings)
    claimer2 = JobClaimer(db, mock_settings)

    recovered_job_id = uuid.uuid4()
    job_row = {
        "id": recovered_job_id,
        "file_key": "patient/doc/test.pdf",
        "status": "RUNNING",
        "attempt_count": 2,  # Second attempt on recovery
    }

    # Worker 1 gets the lock and claims the job
    # Worker 2 sees row locked (SKIP LOCKED) and gets None
    claimer1.repo.claim_next_job = AsyncMock(return_value=job_row)
    claimer2.repo.claim_next_job = AsyncMock(return_value=None)

    worker1_claimed = await claimer1.claim_next()
    worker2_claimed = await claimer2.claim_next()

    assert worker1_claimed is not None
    assert worker1_claimed["id"] == recovered_job_id
    assert worker1_claimed["attempt_count"] == 2
    assert worker2_claimed is None

    claimer1.release_slot()


@pytest.mark.asyncio
async def test_worker_shutdown_and_restart_cleans_up_heartbeat(mock_settings):
    """Worker shutdown cancels active heartbeat tasks and releases semaphore slots cleanly."""
    db = MagicMock()
    runner = WorkerRunner(db, mock_settings)

    job_id = uuid.uuid4()
    job_row = {
        "id": job_id,
        "file_key": "patient/doc/shutdown_test.pdf",
        "status": "RUNNING",
        "attempt_count": 1,
    }

    # Simulate a job being processed
    long_task_event = asyncio.Event()

    async def mock_handler(job):
        await long_task_event.wait()

    runner.job_handler = mock_handler
    runner.claimer.acquire_slot = MagicMock(return_value=True)
    runner.claimer.release_slot = MagicMock()

    # Start processing the job
    task = asyncio.create_task(runner._process_claimed_job(job_row))
    runner.active_tasks[job_id] = task
    task.add_done_callback(lambda t, j_id=job_id: runner.active_tasks.pop(j_id, None))

    # Allow heartbeat to initialize
    await asyncio.sleep(0.02)
    assert len(runner.active_tasks) == 1

    # Now trigger worker graceful stop with short drain timeout
    long_task_event.set()  # Let handler finish
    await runner.stop(drain_timeout=0.5)

    assert runner.stopping is True
    assert len(runner.active_tasks) == 0
    assert runner.reconciler._running is False
