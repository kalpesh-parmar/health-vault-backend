from __future__ import annotations

import json
from pathlib import Path
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
from app.core.errors import NonMedicalDocumentException
from app.infrastructure.storage.s3 import CorruptFileException
from app.services.pipeline.checkpoint_service import (
    LARGE_ARTIFACT_THRESHOLD_BYTES,
    CheckpointService,
)
from app.services.pipeline.orchestrator import PipelineOrchestrator


@pytest.mark.asyncio
async def test_checkpoint_stores_large_payload_to_s3():
    repo = MagicMock()
    repo.update_job_checkpoint = AsyncMock()
    s3_client = MagicMock()
    s3_client.upload_json_artifact = AsyncMock(return_value="report.pdf.ocr_running.json")

    service = CheckpointService(job_repo=repo, s3_client=s3_client)

    job_id = uuid4()
    file_key = "patient/123/doc/report.pdf"
    bucket = "health-vault-docs"

    # Create payload > 500KB
    large_text = "A" * (LARGE_ARTIFACT_THRESHOLD_BYTES + 1024)
    stage_data = {"largeField": large_text}

    checkpoint_data = await service.persist_stage_checkpoint(
        job_id=job_id,
        file_key=file_key,
        bucket=bucket,
        stage=STAGE_OCR_RUNNING,
        progress_pct=50,
        message="Large OCR data stored",
        stage_data=stage_data,
        completed_stages=[STAGE_VALIDATING, STAGE_UPLOADING, STAGE_OCR_RUNNING],
        checkpoint_data={},
    )

    s3_client.upload_json_artifact.assert_called_once()
    assert checkpoint_data[STAGE_OCR_RUNNING]["_s3_ref"] is True
    assert checkpoint_data[STAGE_OCR_RUNNING]["s3Bucket"] == bucket
    repo.update_job_checkpoint.assert_called_once()


@pytest.mark.asyncio
async def test_resume_skips_all_completed_stages():
    repo = MagicMock()
    repo.update_job_checkpoint = AsyncMock()
    repo.complete_job = AsyncMock()

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()

    checkpoint = MagicMock()
    checkpoint.persist_stage_checkpoint = AsyncMock(return_value={})
    checkpoint.load_stage_artifact = AsyncMock()

    s3_client = MagicMock()
    s3_client.read_bytes = AsyncMock(return_value=b"dummy")

    ocr_handler = MagicMock()
    layout_handler = MagicMock()
    graph_handler = MagicMock()
    clinical_handler = MagicMock()
    analysis_handler = MagicMock()
    summary_handler = MagicMock()
    summary_handler.generate_summary = AsyncMock(return_value={"summaryEnglish": "Summary"})
    embedding_handler = MagicMock()
    embedding_handler.generate_embeddings = AsyncMock(return_value={"chunkCount": 2})

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

    # Simulate job that already completed stages 1 to 7
    job = {
        "id": uuid4(),
        "file_key": "patient/doc/test.pdf",
        "completed_stages": [
            STAGE_VALIDATING,
            STAGE_UPLOADING,
            STAGE_OCR_RUNNING,
            STAGE_PARSING,
            STAGE_GRAPH_EXTRACTION,
            STAGE_FIELD_EXTRACTION,
            STAGE_ANALYZING,
        ],
        "checkpoint_data": {"s3Bucket": "test-bucket"},
        "percentage": 85,
        "raw_ocr_data": {"fullText": "Patient with cough and fever"},
        "extracted_structured_data": {"diagnosis": ["Acute Bronchitis"]},
    }

    await orchestrator.process_job(job)

    # Stages 1-7 handlers must NOT have been called!
    ocr_handler.validate_document.assert_not_called()
    ocr_handler.verify_upload.assert_not_called()
    ocr_handler.run_ocr.assert_not_called()
    layout_handler.parse_layout.assert_not_called()
    graph_handler.extract_graphs.assert_not_called()
    clinical_handler.extract_fields.assert_not_called()
    analysis_handler.analyze.assert_not_called()

    # Stages 8 and 9 MUST have been called to complete the job
    summary_handler.generate_summary.assert_called_once()
    embedding_handler.generate_embeddings.assert_called_once()
    repo.complete_job.assert_called_once()


@pytest.mark.asyncio
async def test_orchestrator_non_medical_rejection(tmp_path: Path):
    repo = MagicMock()
    repo.reject_job = AsyncMock()

    lifecycle = MagicMock()
    lifecycle.notifier = MagicMock()
    lifecycle.notifier.publish_progress = AsyncMock()

    checkpoint = MagicMock()
    s3_client = MagicMock()
    s3_client.read_bytes = AsyncMock(return_value=b"fake bill bytes")

    fake_pdf = tmp_path / "fake.pdf"
    fake_pdf.write_bytes(b"fake bill bytes")

    ocr_handler = MagicMock()
    ocr_handler.verify_upload = AsyncMock(return_value=fake_pdf)
    ocr_handler.validate_document = AsyncMock(
        side_effect=NonMedicalDocumentException("Electricity bill rejected")
    )

    orchestrator = PipelineOrchestrator(
        job_repo=repo,
        lifecycle_service=lifecycle,
        checkpoint_service=checkpoint,
        s3_client=s3_client,
        ocr_handler=ocr_handler,
        layout_handler=MagicMock(),
        graph_handler=MagicMock(),
        clinical_handler=MagicMock(),
        analysis_handler=MagicMock(),
        summary_handler=MagicMock(),
        embedding_handler=MagicMock(),
    )

    job_id = uuid4()
    job = {
        "id": job_id,
        "file_key": "patient/doc/bill.pdf",
        "completed_stages": [],
        "checkpoint_data": {},
        "percentage": 0,
    }

    await orchestrator.process_job(job)

    # Job must be rejected, not marked failed
    repo.reject_job.assert_called_once()
    assert "Electricity bill rejected" in repo.reject_job.call_args[1]["reason"]
    lifecycle.notifier.publish_progress.assert_called_once()
    assert lifecycle.notifier.publish_progress.call_args[1]["stage_status"] == "REJECTED"


@pytest.mark.asyncio
async def test_orchestrator_corrupt_file_rejection():
    repo = MagicMock()
    repo.reject_job = AsyncMock()

    lifecycle = MagicMock()
    lifecycle.notifier = MagicMock()
    lifecycle.notifier.publish_progress = AsyncMock()

    ocr_handler = MagicMock()
    ocr_handler.verify_upload = AsyncMock(
        side_effect=CorruptFileException("SHA256 mismatch detected")
    )

    orchestrator = PipelineOrchestrator(
        job_repo=repo,
        lifecycle_service=lifecycle,
        checkpoint_service=MagicMock(),
        s3_client=MagicMock(),
        ocr_handler=ocr_handler,
        layout_handler=MagicMock(),
        graph_handler=MagicMock(),
        clinical_handler=MagicMock(),
        analysis_handler=MagicMock(),
        summary_handler=MagicMock(),
        embedding_handler=MagicMock(),
    )

    job_id = uuid4()
    job = {
        "id": job_id,
        "file_key": "patient/doc/corrupt.pdf",
        "completed_stages": [],
        "checkpoint_data": {},
        "percentage": 0,
    }

    await orchestrator.process_job(job)

    repo.reject_job.assert_called_once()
    assert "SHA256 mismatch detected" in repo.reject_job.call_args[1]["reason"]
    assert lifecycle.notifier.publish_progress.call_args[1]["stage_status"] == "REJECTED"
