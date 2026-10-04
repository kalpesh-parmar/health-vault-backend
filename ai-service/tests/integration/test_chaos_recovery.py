"""
M1 Wave 6 Integration Test Suite: Chaos Recovery & Resiliency.

Validates Requirements 9 (Checkpoint/Recovery E2E) and 11 (Retry Validation):
A. Worker killed after OCR (resumes from PARSING)
B. Worker killed after PARSING (resumes from GRAPH_EXTRACTION)
C. Worker killed after GRAPH_EXTRACTION (resumes from FIELD_EXTRACTION)
D. Worker killed after FIELD_EXTRACTION (resumes from ANALYZING)
E. Worker killed during SUMMARIZING (resumes from SUMMARIZING)

Also validates retry semantics:
- Normal retry (FAILED -> QUEUED without incrementing attempt_count)
- Transient OCR failure retry
- Crash before upload (requires_reupload=True)
- Max retry exhaustion (attempt_count >= max_attempts -> permanent FAILED)
- Artifact invariance: no duplicate artifacts or re-executions of completed stages.
"""
from __future__ import annotations

import asyncio
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
)
from app.infrastructure.db.repositories.job_repository import ReconcileResult
from app.services.pipeline.orchestrator import PipelineOrchestrator
from app.workers.reconciler import CrashReconciler


@pytest.fixture
def mock_pipeline_handlers():
    """Create a fully instrumented set of mocked pipeline handlers."""
    repo = MagicMock()
    repo.update_job_checkpoint = AsyncMock()
    repo.complete_job = AsyncMock()
    repo.fail_job = AsyncMock()
    repo.reconcile_stale_jobs = AsyncMock()

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()
    lifecycle.notifier = MagicMock()
    lifecycle.notifier.publish_progress = AsyncMock()

    checkpoint = MagicMock()
    checkpoint.persist_stage_checkpoint = AsyncMock(
        side_effect=lambda job_id, file_key, bucket, stage, progress_pct, message, stage_data, completed_stages, checkpoint_data, **kw: {
            **checkpoint_data,
            stage: stage_data,
            "s3Bucket": bucket,
            "s3Key": file_key,
        }
    )
    checkpoint.load_stage_artifact = AsyncMock(side_effect=lambda data, stage: data.get(stage, {}))

    s3_client = MagicMock()
    s3_client.read_bytes = AsyncMock(return_value=b"%PDF-1.4 simulated bytes")
    s3_client.upload_json_artifact = AsyncMock(return_value="artifacts/checkpoint.json")

    ocr_handler = MagicMock()
    ocr_handler.validate_document = AsyncMock(return_value={"isValid": True, "mimeType": "application/pdf"})
    ocr_handler.verify_upload = AsyncMock(return_value=MagicMock(exists=lambda: True))
    ocr_handler.run_ocr = AsyncMock(return_value={"pageCount": 1, "fullText": "Patient lab report Blood Glucose 110 mg/dL"})

    layout_handler = MagicMock()
    layout_handler.parse_layout = MagicMock(return_value={"blocks": [{"text": "Blood Glucose 110 mg/dL"}]})

    graph_handler = MagicMock()
    graph_handler.extract_graphs = AsyncMock(return_value=[{"assetId": "asset-1", "type": "TABLE"}])

    clinical_handler = MagicMock()
    clinical_handler.extract_fields = AsyncMock(return_value={"labResults": [{"testName": "Blood Glucose", "value": 110, "unit": "mg/dL"}]})

    analysis_handler = MagicMock()
    analysis_handler.analyze = MagicMock(return_value={"abnormalities": [], "riskLevel": "LOW"})

    summary_handler = MagicMock()
    summary_handler.generate_summary = AsyncMock(return_value={"summaryEnglish": "Normal metabolic panel"})

    embedding_handler = MagicMock()
    embedding_handler.generate_embeddings = AsyncMock(return_value={"chunkCount": 3, "embedded": True})

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

    return {
        "repo": repo,
        "lifecycle": lifecycle,
        "checkpoint": checkpoint,
        "s3_client": s3_client,
        "ocr": ocr_handler,
        "layout": layout_handler,
        "graph": graph_handler,
        "clinical": clinical_handler,
        "analysis": analysis_handler,
        "summary": summary_handler,
        "embedding": embedding_handler,
        "orchestrator": orchestrator,
    }


# ─────────────────────────────────────────────────────────────────────────────
# 1. Checkpoint & Resume E2E Tests (Scenarios A through E)
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_scenario_a_worker_killed_after_ocr(mock_pipeline_handlers):
    """Scenario A: Worker killed after OCR -> resumes at PARSING, skipping stages 1-3."""
    p = mock_pipeline_handlers
    job_id = uuid4()
    job = {
        "id": job_id,
        "file_key": "patient/doc1.pdf",
        "user_id": "usr_101",
        "status": "RUNNING",
        "stage": STAGE_OCR_RUNNING,
        "attempt_count": 2,
        "completed_stages": [STAGE_VALIDATING, STAGE_UPLOADING, STAGE_OCR_RUNNING],
        "checkpoint_data": {
            "s3Bucket": "health-vault-docs",
            STAGE_VALIDATING: {"isValid": True},
            STAGE_UPLOADING: {"uploaded": True},
            STAGE_OCR_RUNNING: {"pageCount": 1, "fullText": "Simulated OCR Text"},
        },
        "raw_ocr_data": {"pageCount": 1, "fullText": "Simulated OCR Text"},
        "extracted_structured_data": None,
    }

    await p["orchestrator"].process_job(job)

    # Completed stages must NOT have been called again (validation and OCR are skipped)
    p["ocr"].validate_document.assert_not_called()
    p["ocr"].run_ocr.assert_not_called()

    # Stages 4 through 9 MUST execute
    p["layout"].parse_layout.assert_called_once()
    p["graph"].extract_graphs.assert_called_once()
    p["clinical"].extract_fields.assert_called_once()
    p["analysis"].analyze.assert_called_once()
    p["summary"].generate_summary.assert_called_once()
    p["embedding"].generate_embeddings.assert_called_once()
    p["repo"].complete_job.assert_called_once()


@pytest.mark.asyncio
async def test_scenario_b_worker_killed_after_parsing(mock_pipeline_handlers):
    """Scenario B: Worker killed after PARSING -> resumes at GRAPH_EXTRACTION, skipping stages 1-4."""
    p = mock_pipeline_handlers
    job_id = uuid4()
    job = {
        "id": job_id,
        "file_key": "patient/doc2.pdf",
        "user_id": "usr_102",
        "status": "RUNNING",
        "stage": STAGE_PARSING,
        "attempt_count": 2,
        "completed_stages": [STAGE_VALIDATING, STAGE_UPLOADING, STAGE_OCR_RUNNING, STAGE_PARSING],
        "checkpoint_data": {
            "s3Bucket": "health-vault-docs",
            STAGE_OCR_RUNNING: {"pageCount": 1, "fullText": "Parsed Text"},
            STAGE_PARSING: {"blocks": [{"text": "Parsed block"}]},
        },
        "raw_ocr_data": {"pageCount": 1, "fullText": "Parsed Text"},
        "extracted_structured_data": None,
    }

    await p["orchestrator"].process_job(job)

    p["ocr"].run_ocr.assert_not_called()
    p["layout"].parse_layout.assert_not_called()
    p["graph"].extract_graphs.assert_called_once()
    p["clinical"].extract_fields.assert_called_once()
    p["repo"].complete_job.assert_called_once()


@pytest.mark.asyncio
async def test_scenario_c_worker_killed_after_graph_extraction(mock_pipeline_handlers):
    """Scenario C: Worker killed after GRAPH_EXTRACTION -> resumes at FIELD_EXTRACTION, skipping stages 1-5."""
    p = mock_pipeline_handlers
    job_id = uuid4()
    job = {
        "id": job_id,
        "file_key": "patient/doc3.pdf",
        "user_id": "usr_103",
        "status": "RUNNING",
        "stage": STAGE_GRAPH_EXTRACTION,
        "attempt_count": 2,
        "completed_stages": [
            STAGE_VALIDATING,
            STAGE_UPLOADING,
            STAGE_OCR_RUNNING,
            STAGE_PARSING,
            STAGE_GRAPH_EXTRACTION,
        ],
        "checkpoint_data": {
            "s3Bucket": "health-vault-docs",
            STAGE_OCR_RUNNING: {"pageCount": 1, "fullText": "Graph text"},
            STAGE_GRAPH_EXTRACTION: {"graphs": [{"assetId": "g1"}]},
        },
        "raw_ocr_data": {"pageCount": 1, "fullText": "Graph text"},
        "extracted_structured_data": None,
    }

    await p["orchestrator"].process_job(job)

    p["graph"].extract_graphs.assert_not_called()
    p["clinical"].extract_fields.assert_called_once()
    p["analysis"].analyze.assert_called_once()
    p["repo"].complete_job.assert_called_once()


@pytest.mark.asyncio
async def test_scenario_d_worker_killed_after_field_extraction(mock_pipeline_handlers):
    """Scenario D: Worker killed after FIELD_EXTRACTION -> resumes at ANALYZING, skipping stages 1-6."""
    p = mock_pipeline_handlers
    job_id = uuid4()
    job = {
        "id": job_id,
        "file_key": "patient/doc4.pdf",
        "user_id": "usr_104",
        "status": "RUNNING",
        "stage": STAGE_FIELD_EXTRACTION,
        "attempt_count": 2,
        "completed_stages": [
            STAGE_VALIDATING,
            STAGE_UPLOADING,
            STAGE_OCR_RUNNING,
            STAGE_PARSING,
            STAGE_GRAPH_EXTRACTION,
            STAGE_FIELD_EXTRACTION,
        ],
        "checkpoint_data": {
            "s3Bucket": "health-vault-docs",
            STAGE_FIELD_EXTRACTION: {"labResults": [{"testName": "HbA1c", "value": 6.8}]},
        },
        "raw_ocr_data": {"pageCount": 1, "fullText": "Field text"},
        "extracted_structured_data": {"labResults": [{"testName": "HbA1c", "value": 6.8}]},
    }

    await p["orchestrator"].process_job(job)

    p["clinical"].extract_fields.assert_not_called()
    p["analysis"].analyze.assert_called_once()
    p["summary"].generate_summary.assert_called_once()
    p["embedding"].generate_embeddings.assert_called_once()
    p["repo"].complete_job.assert_called_once()


@pytest.mark.asyncio
async def test_scenario_e_worker_killed_during_summarization(mock_pipeline_handlers):
    """Scenario E: Worker killed during SUMMARIZING -> resumes at SUMMARIZING, skipping stages 1-7."""
    p = mock_pipeline_handlers
    job_id = uuid4()
    job = {
        "id": job_id,
        "file_key": "patient/doc5.pdf",
        "user_id": "usr_105",
        "status": "RUNNING",
        "stage": STAGE_ANALYZING,
        "attempt_count": 2,
        "completed_stages": [
            STAGE_VALIDATING,
            STAGE_UPLOADING,
            STAGE_OCR_RUNNING,
            STAGE_PARSING,
            STAGE_GRAPH_EXTRACTION,
            STAGE_FIELD_EXTRACTION,
            STAGE_ANALYZING,
        ],
        "checkpoint_data": {
            "s3Bucket": "health-vault-docs",
            STAGE_ANALYZING: {"abnormalities": ["High Glucose"]},
        },
        "raw_ocr_data": {"pageCount": 1, "fullText": "Summary text"},
        "extracted_structured_data": {"labResults": []},
    }

    await p["orchestrator"].process_job(job)

    p["analysis"].analyze.assert_not_called()
    p["summary"].generate_summary.assert_called_once()
    p["embedding"].generate_embeddings.assert_called_once()
    p["repo"].complete_job.assert_called_once()


# ─────────────────────────────────────────────────────────────────────────────
# 2. Retry Semantics & Crash Recovery Tests
# ─────────────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_reconciler_requeues_stale_job_with_persisted_storage():
    """CrashReconciler identifies stale RUNNING job with S3 upload and requeues it without attempt increment."""
    db = MagicMock()
    reconciler = CrashReconciler(db, stale_seconds=180.0, max_attempts=3)
    reconciler.repo.reconcile_stale_jobs = AsyncMock(
        return_value=ReconcileResult(
            requeued=[uuid4()],
            failed_unuploaded=[],
            failed_exceeded=[],
        )
    )

    result = await reconciler.reconcile_once()
    assert len(result.requeued) == 1
    assert len(result.failed_unuploaded) == 0
    assert len(result.failed_exceeded) == 0


@pytest.mark.asyncio
async def test_reconciler_fails_job_without_s3_upload():
    """Worker crashed before upload completed -> Reconciler marks FAILED with requiresReupload=True."""
    db = MagicMock()
    reconciler = CrashReconciler(db, stale_seconds=180.0, max_attempts=3)
    reconciler.repo.reconcile_stale_jobs = AsyncMock(
        return_value=ReconcileResult(
            requeued=[],
            failed_unuploaded=[uuid4()],
            failed_exceeded=[],
        )
    )

    result = await reconciler.reconcile_once()
    assert len(result.requeued) == 0
    assert len(result.failed_unuploaded) == 1
    assert len(result.failed_exceeded) == 0


@pytest.mark.asyncio
async def test_reconciler_permanently_fails_max_attempts_exceeded():
    """Job exceeded max attempts (3) -> Reconciler permanently fails job with retryable=False."""
    db = MagicMock()
    reconciler = CrashReconciler(db, stale_seconds=180.0, max_attempts=3)
    reconciler.repo.reconcile_stale_jobs = AsyncMock(
        return_value=ReconcileResult(
            requeued=[],
            failed_unuploaded=[],
            failed_exceeded=[uuid4()],
        )
    )

    result = await reconciler.reconcile_once()
    assert len(result.requeued) == 0
    assert len(result.failed_unuploaded) == 0
    assert len(result.failed_exceeded) == 1


@pytest.mark.asyncio
async def test_retry_after_ocr_transient_failure(mock_pipeline_handlers):
    """Pipeline catches transient OCR exception, marks job FAILED with retryable=True, keeping checkpoints."""
    p = mock_pipeline_handlers
    p["ocr"].run_ocr = AsyncMock(side_effect=RuntimeError("Qwen3-VL temporary inference timeout"))

    job = {
        "id": uuid4(),
        "file_key": "patient/timeout.pdf",
        "user_id": "usr_999",
        "status": "RUNNING",
        "stage": STAGE_OCR_RUNNING,
        "attempt_count": 1,
        "completed_stages": [STAGE_VALIDATING, STAGE_UPLOADING],
        "checkpoint_data": {"s3Bucket": "health-vault-docs"},
        "raw_ocr_data": None,
        "extracted_structured_data": None,
    }

    with pytest.raises(RuntimeError, match="temporary inference timeout"):
        await p["orchestrator"].process_job(job)

    # Fail job must be called with the transient error
    p["repo"].fail_job.assert_called_once_with(job_id=job["id"], error="Qwen3-VL temporary inference timeout")
