from __future__ import annotations

import math
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import UUID, uuid4

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
    STATUS_FAILED,
    STATUS_IN_PROGRESS,
)
from app.core.errors import StageExecutionError
from app.infrastructure.db.repositories.intelligence_repository import IntelligenceRepository
from app.services.pipeline.orchestrator import PipelineOrchestrator


@pytest.fixture
def sample_vector_1024() -> list[float]:
    return [0.01 * (i % 25) for i in range(1024)]


@pytest.fixture
def sample_chunks(sample_vector_1024) -> list[dict[str, Any]]:
    return [
        {
            "chunkIndex": 0,
            "text": "Patient presents with persistent cough and mild fever.",
            "vector": sample_vector_1024,
            "tokenEstimate": 12,
            "charCount": 54,
        },
        {
            "chunkIndex": 1,
            "text": "Prescribed Amoxicillin 500mg TID for 7 days.",
            "vector": [v * 0.5 for v in sample_vector_1024],
            "tokenEstimate": 10,
            "charCount": 44,
        },
    ]


@pytest.mark.asyncio
async def test_persist_chunks_success():
    """Requirement 1, 2, 7: Verify chunks & vectors are inserted and committed."""
    mock_session = AsyncMock()
    mock_count_chunks = MagicMock()
    mock_count_chunks.scalar.return_value = 2
    mock_count_embeddings = MagicMock()
    mock_count_embeddings.scalar.return_value = 2

    # Session execute returns count results on verification
    mock_session.execute = AsyncMock(side_effect=[
        MagicMock(),  # delete embeddings
        MagicMock(),  # delete chunks
        MagicMock(),  # insert chunk 0
        MagicMock(),  # insert embedding 0
        MagicMock(),  # insert chunk 1
        MagicMock(),  # insert embedding 1
        mock_count_chunks,     # verify chunk count
        mock_count_embeddings, # verify embedding count
    ])

    repo = IntelligenceRepository(session=mock_session)
    doc_id = uuid4()
    patient_id = uuid4()
    chunks = [
        {"chunkIndex": 0, "text": "Text 1", "vector": [0.1] * 1024, "tokenEstimate": 5, "charCount": 6},
        {"chunkIndex": 1, "text": "Text 2", "vector": [0.2] * 1024, "tokenEstimate": 5, "charCount": 6},
    ]

    c_cnt, e_cnt = await repo.persist_document_chunks_and_embeddings(
        document_id=doc_id,
        user_id=patient_id,
        chunks=chunks,
    )

    assert c_cnt == 2
    assert e_cnt == 2
    mock_session.commit.assert_awaited_once()
    mock_session.rollback.assert_not_awaited()


@pytest.mark.asyncio
async def test_persist_chunks_rollback_on_failure():
    """Requirement 3: Verify single atomic transaction rolls back on any insert failure."""
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(side_effect=[
        MagicMock(),  # delete embeddings
        MagicMock(),  # delete chunks
        RuntimeError("Database connection lost during insert"),
    ])

    repo = IntelligenceRepository(session=mock_session)
    doc_id = uuid4()
    patient_id = uuid4()
    chunks = [
        {"chunkIndex": 0, "text": "Text 1", "vector": [0.1] * 1024, "tokenEstimate": 5, "charCount": 6},
    ]

    with pytest.raises(RuntimeError, match="Database connection lost"):
        await repo.persist_document_chunks_and_embeddings(
            document_id=doc_id,
            user_id=patient_id,
            chunks=chunks,
        )

    mock_session.rollback.assert_awaited_once()
    mock_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_persist_chunks_vector_dimension_validation():
    """Requirement 4: Reject non-1024 dimension vectors before touching DB."""
    mock_session = AsyncMock()
    repo = IntelligenceRepository(session=mock_session)

    bad_chunks = [
        {"chunkIndex": 0, "text": "Text 1", "vector": [0.1] * 512, "tokenEstimate": 5},
    ]

    with pytest.raises(ValueError, match="expected dimension 1024, got 512"):
        await repo.persist_document_chunks_and_embeddings(
            document_id=uuid4(),
            user_id=uuid4(),
            chunks=bad_chunks,
        )

    mock_session.execute.assert_not_called()


@pytest.mark.asyncio
async def test_persist_chunks_non_finite_vector_validation():
    """Requirement 4: Reject non-finite vector values (NaN, Inf)."""
    mock_session = AsyncMock()
    repo = IntelligenceRepository(session=mock_session)

    bad_vector = [0.1] * 1024
    bad_vector[42] = float("nan")

    bad_chunks = [
        {"chunkIndex": 0, "text": "Text 1", "vector": bad_vector, "tokenEstimate": 5},
    ]

    with pytest.raises(ValueError, match="non-finite or invalid float"):
        await repo.persist_document_chunks_and_embeddings(
            document_id=uuid4(),
            user_id=uuid4(),
            chunks=bad_chunks,
        )

    mock_session.execute.assert_not_called()


@pytest.mark.asyncio
async def test_persist_chunks_zero_chunks_handling():
    """Requirement 11: Empty OCR text gracefully removes old chunks and returns (0, 0)."""
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=MagicMock())

    repo = IntelligenceRepository(session=mock_session)
    c_cnt, e_cnt = await repo.persist_document_chunks_and_embeddings(
        document_id=uuid4(),
        user_id=uuid4(),
        chunks=[],
    )

    assert c_cnt == 0
    assert e_cnt == 0
    # Verified that DELETE was issued to clean up, and commit was called
    assert mock_session.execute.await_count == 2
    mock_session.commit.assert_awaited_once()


@pytest.mark.asyncio
async def test_persist_chunks_count_mismatch_triggers_rollback():
    """Requirement 7: If persisted count does not match expected, rollback and raise."""
    mock_session = AsyncMock()
    mock_count_chunks = MagicMock()
    mock_count_chunks.scalar.return_value = 1  # only 1 inserted instead of 2
    mock_count_embeddings = MagicMock()
    mock_count_embeddings.scalar.return_value = 1

    mock_session.execute = AsyncMock(side_effect=[
        MagicMock(),  # delete embeddings
        MagicMock(),  # delete chunks
        MagicMock(),  # insert chunk 0
        MagicMock(),  # insert embedding 0
        MagicMock(),  # insert chunk 1
        MagicMock(),  # insert embedding 1
        mock_count_chunks,
        mock_count_embeddings,
    ])

    repo = IntelligenceRepository(session=mock_session)
    chunks = [
        {"chunkIndex": 0, "text": "T1", "vector": [0.1] * 1024},
        {"chunkIndex": 1, "text": "T2", "vector": [0.2] * 1024},
    ]

    with pytest.raises(RuntimeError, match="Chunk persistence count mismatch"):
        await repo.persist_document_chunks_and_embeddings(
            document_id=uuid4(),
            user_id=uuid4(),
            chunks=chunks,
        )

    mock_session.rollback.assert_awaited_once()
    mock_session.commit.assert_not_awaited()


@pytest.mark.asyncio
async def test_orchestrator_embedding_persistence_failure_stops_pipeline(tmp_path: Path):
    """Requirement 8 & 10: Document is NOT completed if embedding persistence fails; FAILED is emitted."""
    job_repo = AsyncMock()
    lifecycle_service = AsyncMock()
    lifecycle_service.notifier = AsyncMock()
    checkpoint_service = AsyncMock()
    checkpoint_service.load_raw_ocr_data = AsyncMock(side_effect=lambda raw_ocr_data, **kw: raw_ocr_data)
    checkpoint_service.load_extracted_structured_data = AsyncMock(side_effect=lambda extracted_data, **kw: extracted_data or {"documentInfo": {}})
    checkpoint_service.persist_stage_checkpoint = AsyncMock(return_value={})

    s3_client = MagicMock()
    s3_client.settings = MagicMock(aws_bucket_name="health-vault-documents")

    ocr_handler = AsyncMock()
    ocr_file = tmp_path / "test_doc.pdf"
    ocr_file.write_bytes(b"%PDF-1.4 dummy")
    ocr_handler.verify_upload = AsyncMock(return_value=ocr_file)
    ocr_handler.validate_document = AsyncMock(return_value={"isValid": True})

    layout_handler = MagicMock()
    graph_handler = AsyncMock()
    clinical_handler = AsyncMock()
    analysis_handler = MagicMock()
    summary_handler = AsyncMock()

    # Embedding handler generates chunks successfully
    embedding_handler = AsyncMock()
    embedding_handler.generate_embeddings = AsyncMock(return_value={
        "embeddingsGenerated": True,
        "chunkCount": 1,
        "chunks": [{"chunkIndex": 0, "text": "Some text", "vector": [0.1] * 1024}],
    })

    # Intelligence repository fails during persistence
    intelligence_repo = AsyncMock()
    intelligence_repo.persist_document_chunks_and_embeddings = AsyncMock(
        side_effect=RuntimeError("PostgreSQL constraint violation")
    )

    orchestrator = PipelineOrchestrator(
        job_repo=job_repo,
        lifecycle_service=lifecycle_service,
        checkpoint_service=checkpoint_service,
        s3_client=s3_client,
        ocr_handler=ocr_handler,
        layout_handler=layout_handler,
        graph_handler=graph_handler,
        clinical_handler=clinical_handler,
        analysis_handler=analysis_handler,
        summary_handler=summary_handler,
        embedding_handler=embedding_handler,
        intelligence_repo=intelligence_repo,
    )

    doc_id = uuid4()
    patient_id = uuid4()
    job_id = uuid4()
    job_payload = {
        "id": job_id,
        "file_key": "test_doc.pdf",
        "document_id": doc_id,
        "user_id": patient_id,
        "completed_stages": [
            STAGE_VALIDATING,
            STAGE_UPLOADING,
            STAGE_OCR_RUNNING,
            STAGE_PARSING,
            STAGE_GRAPH_EXTRACTION,
            STAGE_FIELD_EXTRACTION,
            STAGE_ANALYZING,
            STAGE_SUMMARIZING,
        ],
        "checkpoint_data": {},
        "raw_ocr_data": {"fullText": "Some text", "metrics": {"failed_page_count": 0}},
        "extracted_structured_data": {"documentInfo": {"date": "2026-01-01"}},
        "attempt_count": 1,
    }

    await orchestrator.process_job(job_payload)

    # complete_job must NOT be called
    job_repo.complete_job.assert_not_called()
    job_repo.sync_to_documents_table.assert_not_called()

    # Terminal FAILED event must be published through SSE notifier
    lifecycle_service.notifier.publish_progress.assert_awaited()
    last_call = lifecycle_service.notifier.publish_progress.call_args_list[-1]
    assert last_call.kwargs.get("stage_status") == STATUS_FAILED
    assert last_call.kwargs.get("failed_stage") == STAGE_EMBEDDING
    assert last_call.kwargs.get("retryable") is True


@pytest.mark.asyncio
async def test_orchestrator_stage_retry_resumes_from_embedding(tmp_path: Path):
    """Requirement 9: Retry from EMBEDDING without rerunning successful OCR or parsing."""
    job_repo = AsyncMock()
    job_repo.complete_job.return_value = True
    lifecycle_service = AsyncMock()
    lifecycle_service.notifier = AsyncMock()
    checkpoint_service = AsyncMock()
    checkpoint_service.load_raw_ocr_data = AsyncMock(side_effect=lambda raw_ocr_data, **kw: raw_ocr_data)
    checkpoint_service.load_extracted_structured_data = AsyncMock(side_effect=lambda extracted_data, **kw: extracted_data or {"documentInfo": {}})
    checkpoint_service.persist_stage_checkpoint = AsyncMock(return_value={})

    s3_client = MagicMock()
    s3_client.settings = MagicMock(aws_bucket_name="health-vault-documents")

    ocr_handler = AsyncMock()
    ocr_file = tmp_path / "test_doc.pdf"
    ocr_file.write_bytes(b"%PDF-1.4 dummy")
    ocr_handler.verify_upload = AsyncMock(return_value=ocr_file)
    ocr_handler.validate_document = AsyncMock(return_value={"isValid": True})

    layout_handler = MagicMock()
    graph_handler = AsyncMock()
    clinical_handler = AsyncMock()
    analysis_handler = MagicMock()
    summary_handler = AsyncMock()

    embedding_handler = AsyncMock()
    embedding_handler.embeddings = MagicMock()
    embedding_handler.embeddings.model_name = "bge-m3:latest"
    embedding_handler.embeddings.expected_dim = 1024
    embedding_handler.generate_embeddings = AsyncMock(return_value={
        "embeddingsGenerated": True,
        "chunkCount": 2,
        "chunks": [
            {"chunkIndex": 0, "text": "Chunk 1", "vector": [0.1] * 1024},
            {"chunkIndex": 1, "text": "Chunk 2", "vector": [0.2] * 1024},
        ],
    })

    intelligence_repo = AsyncMock()
    intelligence_repo.persist_document_chunks_and_embeddings = AsyncMock(return_value=(2, 2))

    orchestrator = PipelineOrchestrator(
        job_repo=job_repo,
        lifecycle_service=lifecycle_service,
        checkpoint_service=checkpoint_service,
        s3_client=s3_client,
        ocr_handler=ocr_handler,
        layout_handler=layout_handler,
        graph_handler=graph_handler,
        clinical_handler=clinical_handler,
        analysis_handler=analysis_handler,
        summary_handler=summary_handler,
        embedding_handler=embedding_handler,
        intelligence_repo=intelligence_repo,
    )

    doc_id = uuid4()
    patient_id = uuid4()
    job_id = uuid4()
    job_payload = {
        "id": job_id,
        "file_key": "test_doc.pdf",
        "document_id": doc_id,
        "user_id": patient_id,
        # Stages up to SUMMARIZING are already completed
        "completed_stages": [
            STAGE_VALIDATING,
            STAGE_UPLOADING,
            STAGE_OCR_RUNNING,
            STAGE_PARSING,
            STAGE_GRAPH_EXTRACTION,
            STAGE_FIELD_EXTRACTION,
            STAGE_ANALYZING,
            STAGE_SUMMARIZING,
        ],
        "failed_stage": STAGE_EMBEDDING,
        "checkpoint_data": {},
        "raw_ocr_data": {"fullText": "Full text of document", "metrics": {"failed_page_count": 0}},
        "extracted_structured_data": {"documentInfo": {"date": "2026-01-01"}},
        "attempt_count": 2,
    }

    await orchestrator.process_job(job_payload)

    # Verified OCR was NOT re-run
    ocr_handler.verify_upload.assert_not_called()
    ocr_handler.validate_document.assert_not_called()
    # Verified clinical extraction was NOT re-run
    clinical_handler.extract_fields.assert_not_called()
    # Verified summary was NOT re-run
    summary_handler.generate_summary.assert_not_called()

    # Embedding was run and persisted
    embedding_handler.generate_embeddings.assert_awaited_once()
    intelligence_repo.persist_document_chunks_and_embeddings.assert_awaited_once_with(
        document_id=doc_id,
        user_id=patient_id,
        chunks=embedding_handler.generate_embeddings.return_value["chunks"],
        model_name="bge-m3:latest",
        expected_dim=1024,
    )

    # Job was completed successfully
    job_repo.complete_job.assert_awaited_once()
