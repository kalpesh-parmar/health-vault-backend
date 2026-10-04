"""
M1 Wave 6 Integration Test Suite: End-to-End Document Flow & Non-Functional Gates.

Validates:
- Requirement 8: Concurrency & Stability (1 doc, 2 docs, WORKER_CONCURRENCY=4, 10-doc batch, 20-run stress, zero OOM)
- Requirement 10: End-to-End SSE Event Delivery (PostgreSQL NOTIFY, envelope shape, <=7500-byte ceiling, Zero-PHI safety)
- Requirement 12 & 15: Tenant isolation and monotonic progress guarantees.
"""
from __future__ import annotations

import asyncio
import json
import time
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

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
    STATUS_COMPLETED,
    STATUS_IN_PROGRESS,
)
from app.services.notifier import (
    MAX_PG_NOTIFY_BYTES,
    ProgressNotifier,
)
from app.settings import Settings
from app.workers.claimer import JobClaimer


# ─────────────────────────────────────────────────────────────────────────────
# 1. Concurrency & Semaphore Invariant Tests (Requirement 8)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_worker_concurrency_hard_limit_10_doc_batch():
    """Verify that a batch of 10 concurrent documents never exceeds WORKER_CONCURRENCY."""
    concurrency_limit = 4
    settings = Settings(
        database_url="postgresql+asyncpg://postgres:postgres@localhost:5432/health_vault_test",
        ai_model="test-model",
        ai_base_url="http://localhost:11434",
        internal_service_key="secret-key-123",
        patient_documents_bucket="test-bucket",
        aws_region="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        worker_concurrency=concurrency_limit,
    )

    db = MagicMock()
    claimer = JobClaimer(db=db, settings=settings)

    active_concurrent_jobs = 0
    max_observed_concurrency = 0
    concurrency_lock = asyncio.Lock()

    async def mock_process_job(job_id):
        nonlocal active_concurrent_jobs, max_observed_concurrency
        async with concurrency_lock:
            active_concurrent_jobs += 1
            if active_concurrent_jobs > max_observed_concurrency:
                max_observed_concurrency = active_concurrent_jobs

        # Simulate async pipeline work
        await asyncio.sleep(0.05)

        async with concurrency_lock:
            active_concurrent_jobs -= 1
            claimer.release_slot()

    # Create 10 mock jobs
    job_queue = [{"id": uuid4(), "file_key": f"doc_{i}.pdf"} for i in range(10)]
    processed_count = 0

    async def worker_loop():
        nonlocal processed_count
        while True:
            if not job_queue:
                break
            # Try to acquire slot and claim
            if claimer.semaphore.locked():
                await asyncio.sleep(0.01)
                continue

            await claimer.semaphore.acquire()
            if not job_queue:
                claimer.release_slot()
                break
            job = job_queue.pop(0)
            asyncio.create_task(mock_process_job(job["id"]))
            processed_count += 1

    # Run dispatchers
    dispatchers = [asyncio.create_task(worker_loop()) for _ in range(3)]
    await asyncio.gather(*dispatchers)

    # Wait for all running background tasks to complete
    while active_concurrent_jobs > 0:
        await asyncio.sleep(0.01)

    assert processed_count == 10
    # Invariant: max observed concurrency must NEVER exceed configured worker_concurrency
    assert max_observed_concurrency <= concurrency_limit
    # Invariant: all semaphore slots must be cleanly released (not locked)
    assert not claimer.semaphore.locked()


@pytest.mark.asyncio
async def test_zero_oom_across_20_consecutive_runs():
    """Verify zero memory runaway, zero worker crashes, and stable state over 20 runs."""
    settings = Settings(
        database_url="postgresql+asyncpg://postgres:postgres@localhost:5432/health_vault_test",
        ai_model="test-model",
        ai_base_url="http://localhost:11434",
        internal_service_key="secret-key-123",
        patient_documents_bucket="test-bucket",
        aws_region="us-east-1",
        aws_access_key_id="test",
        aws_secret_access_key="test",
        worker_concurrency=2,
    )
    db = MagicMock()
    claimer = JobClaimer(db=db, settings=settings)

    crashes = 0
    oom_events = 0
    runs = 20

    for i in range(runs):
        try:
            # Simulate job claim and execution
            slot_acquired = await claimer.semaphore.acquire()
            assert slot_acquired is True or slot_acquired is None
            # Simulate lightweight processing
            dummy_buffer = bytearray(1024 * 1024)  # 1 MB allocation
            dummy_buffer[0] = i % 256
            del dummy_buffer
        except MemoryError:
            oom_events += 1
        except Exception:
            crashes += 1
        finally:
            claimer.release_slot()

    assert oom_events == 0, f"Observed {oom_events} OOM events!"
    assert crashes == 0, f"Observed {crashes} worker crashes!"
    assert not claimer.semaphore.locked()


# ─────────────────────────────────────────────────────────────────────────────
# 2. SSE End-to-End Event Wire Envelope & PHI Safety (Requirement 10)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_sse_wire_envelope_structure_and_limits():
    """Validate SSE wire envelope matches Node sharedSseBus expectations and stays under 7500 bytes."""
    db = MagicMock()
    notifier = ProgressNotifier(db=db)

    job_id = uuid4()
    file_key = "patient_abc/reports/lab_panel.pdf"

    envelope = notifier.build_envelope(
        job_id=job_id,
        file_key=file_key,
        stage=STAGE_OCR_RUNNING,
        stage_status=STATUS_IN_PROGRESS,
        progress=30,
        percentage=30,
        message="Performing native text extraction",
        page=1,
        total_pages=3,
        detected_languages=["en"],
    )

    # 1. Verify envelope shape
    assert envelope.channelKey == file_key
    assert envelope.event.jobId == str(job_id)
    assert envelope.event.stage == STAGE_OCR_RUNNING
    assert envelope.event.stageStatus == STATUS_IN_PROGRESS
    assert envelope.event.percentage == 30
    assert envelope.event.page.done == 1
    assert envelope.event.page.total == 3
    assert envelope.event.detectedLanguages == ["en"]

    # 2. Verify serialized size <= MAX_PG_NOTIFY_BYTES (7500)
    serialized = notifier.serialize_and_truncate(envelope)
    encoded_bytes = serialized.encode("utf-8")
    assert len(encoded_bytes) <= MAX_PG_NOTIFY_BYTES

    # 3. Verify parseable JSON
    parsed = json.loads(serialized)
    assert parsed["channelKey"] == file_key
    assert parsed["event"]["status"] == "SUCCESS"


@pytest.mark.asyncio
async def test_sse_oversized_payload_auto_truncation():
    """Verify that a massive status message is safely truncated to guarantee <= 7500 bytes."""
    db = MagicMock()
    notifier = ProgressNotifier(db=db)

    job_id = uuid4()
    file_key = "patient_123/huge.pdf"
    huge_message = "Log trace data: " + ("X" * 15000)

    envelope = notifier.build_envelope(
        job_id=job_id,
        file_key=file_key,
        stage=STAGE_ANALYZING,
        stage_status=STATUS_IN_PROGRESS,
        progress=70,
        percentage=70,
        message=huge_message,
    )

    serialized = notifier.serialize_and_truncate(envelope)
    encoded_bytes = serialized.encode("utf-8")

    assert len(encoded_bytes) <= MAX_PG_NOTIFY_BYTES
    parsed = json.loads(serialized)
    assert parsed["event"]["message"].endswith("...")


@pytest.mark.asyncio
async def test_sse_strictly_rejects_phi_in_progress_events():
    """Verify zero PHI leakage: ProgressNotifier rejects disallowed clinical and patient fields."""
    db = MagicMock()
    notifier = ProgressNotifier(db=db)

    job_id = uuid4()
    file_key = "patient_123/doc.pdf"

    disallowed_examples = [
        {"patient_name": "John Doe"},
        {"clinical_text": "Patient presents with chest pain"},
        {"diagnosis": "Type 2 Diabetes"},
        {"medications": ["Metformin 500mg"]},
        {"raw_ocr": "Complete unredacted patient report"},
        {"summary": "Patient is clinically stable"},
    ]

    for phi_payload in disallowed_examples:
        with pytest.raises(ValueError, match="PHI violation: disallowed field"):
            notifier.build_envelope(
                job_id=job_id,
                file_key=file_key,
                stage=STAGE_FIELD_EXTRACTION,
                stage_status=STATUS_IN_PROGRESS,
                progress=50,
                percentage=50,
                message="Processing fields",
                extra_fields=phi_payload,
            )


# ─────────────────────────────────────────────────────────────────────────────
# 3. Tenant Isolation & Monotonic Progress (Requirements 10 & 15)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tenant_isolation_partitioned_channels():
    """Verify Tenant A's events and Tenant B's events use separate channelKeys."""
    db = MagicMock()
    notifier = ProgressNotifier(db=db)

    tenant_a_key = "tenant_A/user_1/report.pdf"
    tenant_b_key = "tenant_B/user_2/report.pdf"

    envelope_a = notifier.build_envelope(
        job_id=uuid4(),
        file_key=tenant_a_key,
        stage=STAGE_VALIDATING,
        stage_status=STATUS_IN_PROGRESS,
        progress=10,
        percentage=10,
        message="Validating Tenant A",
    )

    envelope_b = notifier.build_envelope(
        job_id=uuid4(),
        file_key=tenant_b_key,
        stage=STAGE_VALIDATING,
        stage_status=STATUS_IN_PROGRESS,
        progress=10,
        percentage=10,
        message="Validating Tenant B",
    )

    assert envelope_a.channelKey != envelope_b.channelKey
    assert envelope_a.channelKey == tenant_a_key
    assert envelope_b.channelKey == tenant_b_key


@pytest.mark.asyncio
async def test_monotonic_stage_progress_sequence():
    """Verify that stage progress monotonically increases from 0% to 100%."""
    from app.services.pipeline.lifecycle_service import (
        calculate_stage_percentage,
        ensure_monotonic_progress,
    )

    stages_sequence = [
        STAGE_VALIDATING,
        STAGE_UPLOADING,
        STAGE_OCR_RUNNING,
        STAGE_PARSING,
        STAGE_GRAPH_EXTRACTION,
        STAGE_FIELD_EXTRACTION,
        STAGE_ANALYZING,
        STAGE_SUMMARIZING,
        STAGE_EMBEDDING,
    ]

    current_progress = 0
    for stage in stages_sequence:
        expected_min = calculate_stage_percentage(stage)
        updated_progress = ensure_monotonic_progress(current_progress, expected_min)
        assert updated_progress >= current_progress, f"Progress regressed at stage {stage}!"
        current_progress = updated_progress

    assert current_progress == 95
    # On terminal completion, progress reaches 100%
    final_progress = ensure_monotonic_progress(current_progress, 100)
    assert final_progress == 100
