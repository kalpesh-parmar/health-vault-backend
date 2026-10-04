from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4
from pathlib import Path
import pytest

from app.services.pipeline.orchestrator import PipelineOrchestrator


@pytest.fixture
def mock_orchestrator(tmp_path: Path):
    repo = MagicMock()
    repo.complete_job = AsyncMock()
    repo.fail_job = AsyncMock()
    repo.reject_job = AsyncMock()
    repo.sync_to_documents_table = AsyncMock()
    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock(return_value=10)
    lifecycle.notifier = MagicMock()
    lifecycle.notifier.publish_progress = AsyncMock()
    checkpoint = MagicMock()
    checkpoint.persist_stage_checkpoint = AsyncMock(return_value={})
    s3_client = MagicMock()
    s3_client.read_bytes = AsyncMock(return_value=b"%PDF-1.4 mock pdf content")
    fake_pdf = tmp_path / "mock_file.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 mock pdf content")
    ocr_handler = MagicMock()
    ocr_handler.verify_upload = AsyncMock(return_value=fake_pdf)
    ocr_handler.validate_document = AsyncMock(return_value={"isValid": True})
    ocr_handler.run_ocr = AsyncMock(return_value={"fullText": "sample text"})
    layout_handler = MagicMock()
    layout_handler.parse_layout = MagicMock(return_value={"blocks": []})
    graph_handler = MagicMock()
    graph_handler.extract_graphs = AsyncMock(return_value=[])
    clinical_handler = MagicMock()
    clinical_handler.extract_fields = AsyncMock(return_value={"fields": {}})
    analysis_handler = MagicMock()
    analysis_handler.analyze = MagicMock(return_value={"analysis": {}, "riskLevel": "LOW"})
    summary_handler = MagicMock()
    summary_handler.generate_summary = AsyncMock(return_value={"summary": "ok"})
    embedding_handler = MagicMock()
    embedding_handler.generate_embeddings = AsyncMock(return_value={"chunkCount": 1})

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
    return orchestrator, ocr_handler, s3_client, lifecycle, repo


@pytest.mark.asyncio
async def test_orchestrator_resolves_s3_key_from_checkpoint_data(mock_orchestrator):
    orchestrator, ocr_handler, s3_client, lifecycle, repo = mock_orchestrator

    job_id = uuid4()
    logical_file_key = "doc_abc123456789"
    physical_s3_key = "DOCUMENT/patient-123/uuid-blood-test.pdf"

    job = {
        "id": job_id,
        "file_key": logical_file_key,
        "completed_stages": [],
        "checkpoint_data": {
            "s3Bucket": "health-vault-dev-bucket",
            "s3Key": physical_s3_key,
            "uploaded": True,
        },
        "metadata": {
            "s3Key": physical_s3_key,
            "key": physical_s3_key,
            "originalName": "blood-test.pdf",
        },
    }

    await orchestrator.process_job(job)

    # 1. S3 operations MUST use physical_s3_key
    ocr_handler.verify_upload.assert_any_call(
        bucket="health-vault-dev-bucket",
        key=physical_s3_key,
        expected_sha256=None,
    )

    # 2. Progress notifications MUST use logical_file_key for SSE channel matching
    assert lifecycle.report_progress.call_count >= 1
    for call in lifecycle.report_progress.call_args_list:
        assert call.kwargs.get("file_key") == logical_file_key


@pytest.mark.asyncio
async def test_orchestrator_falls_back_to_metadata_key(mock_orchestrator):
    orchestrator, ocr_handler, s3_client, lifecycle, repo = mock_orchestrator

    job_id = uuid4()
    logical_file_key = "doc_xyz987654321"
    fallback_s3_key = "DOCUMENT/patient-456/uuid-prescription.pdf"

    job = {
        "id": job_id,
        "file_key": logical_file_key,
        "completed_stages": [],
        "checkpoint_data": {
            "s3Bucket": "health-vault-dev-bucket",
        },
        "metadata": {
            "key": fallback_s3_key,
        },
    }

    await orchestrator.process_job(job)

    ocr_handler.verify_upload.assert_any_call(
        bucket="health-vault-dev-bucket",
        key=fallback_s3_key,
        expected_sha256=None,
    )


@pytest.mark.asyncio
async def test_orchestrator_syncs_canonical_document_id(mock_orchestrator):
    orchestrator, ocr_handler, s3_client, lifecycle, repo = mock_orchestrator

    job_id = uuid4()
    document_id = uuid4()
    logical_file_key = "doc_test123"
    s3_key = "DOCUMENT/patient-789/report.pdf"

    job = {
        "id": job_id,
        "file_key": logical_file_key,
        "completed_stages": [],
        "checkpoint_data": {
            "s3Bucket": "health-vault-dev-bucket",
            "s3Key": s3_key,
            "documentId": str(document_id),
        },
        "metadata": {
            "documentId": str(document_id),
            "key": s3_key,
        },
    }

    await orchestrator.process_job(job)

    # 1. Verify sync_to_documents_table was called with the canonical documentId
    repo.sync_to_documents_table.assert_awaited_once()
    assert repo.sync_to_documents_table.call_args.kwargs["document_id"] == document_id

    # 2. Verify terminal report_progress forwarded document_id
    last_call = lifecycle.report_progress.call_args_list[-1]
    assert last_call.kwargs.get("document_id") == document_id
    assert last_call.kwargs.get("file_key") == logical_file_key
