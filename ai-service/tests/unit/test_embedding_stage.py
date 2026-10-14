from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

from app.modules.embeddings.service import EmbeddingService
from app.services.pipeline.embedding_stage import EmbeddingStageHandler


@pytest.mark.asyncio
async def test_chunking_bounds_under_8192_tokens():
    embedding_service = MagicMock(spec=EmbeddingService)
    embedding_service.expected_dim = 1024
    # Simulate chunk_text returning small passages
    embedding_service.chunk_text.return_value = ["Passage 1 text", "Passage 2 text"]
    embedding_service.embed_texts = AsyncMock(return_value=[[0.1] * 1024, [0.2] * 1024])

    handler = EmbeddingStageHandler(embedding_service=embedding_service)

    sample_text = "This is a comprehensive medical clinical record. " * 50
    patient_id = uuid4()
    document_id = uuid4()

    result = await handler.generate_embeddings(
        full_text=sample_text,
        patient_id=patient_id,
        document_id=document_id,
    )

    assert result["embeddingsGenerated"] is True
    assert result["chunkCount"] == 2
    assert result["vectorDimension"] == 1024
    assert len(result["chunks"]) == 2

    first_chunk = result["chunks"][0]
    assert first_chunk["chunkIndex"] == 0
    assert first_chunk["patientId"] == str(patient_id)
    assert first_chunk["documentId"] == str(document_id)
    assert first_chunk["tokenEstimate"] < 8192
    assert len(first_chunk["vector"]) == 1024


@pytest.mark.asyncio
async def test_embedding_stage_failure_raises_retryable_stage_execution_error():
    from app.core.errors import StageExecutionError

    embedding_service = MagicMock(spec=EmbeddingService)
    embedding_service.expected_dim = 1024
    embedding_service.chunk_text.return_value = ["Fallback chunk"]
    embedding_service.embed_texts = AsyncMock(side_effect=RuntimeError("Ollama unreachable"))

    handler = EmbeddingStageHandler(embedding_service=embedding_service)

    with pytest.raises(StageExecutionError) as exc_info:
        await handler.generate_embeddings(full_text="Sample text")

    err = exc_info.value
    assert err.stage == "EMBEDDING"
    assert err.error_code == "EMBEDDING_FAILED"
    assert err.retryable is True


@pytest.mark.asyncio
async def test_embedding_stage_vector_dimension_mismatch():
    from app.core.errors import StageExecutionError

    embedding_service = MagicMock(spec=EmbeddingService)
    embedding_service.expected_dim = 1024
    embedding_service.chunk_text.return_value = ["Chunk 1"]
    # Return 512 dimensions instead of 1024
    embedding_service.embed_texts = AsyncMock(return_value=[[0.1] * 512])

    handler = EmbeddingStageHandler(embedding_service=embedding_service)

    with pytest.raises(StageExecutionError) as exc_info:
        await handler.generate_embeddings(full_text="Sample text")

    err = exc_info.value
    assert err.stage == "EMBEDDING"
    assert err.error_code == "EMBEDDING_DIMENSION_MISMATCH"


@pytest.mark.asyncio
async def test_embedding_stage_non_finite_vector_value():
    import math
    from app.core.errors import StageExecutionError

    embedding_service = MagicMock(spec=EmbeddingService)
    embedding_service.expected_dim = 1024
    embedding_service.chunk_text.return_value = ["Chunk 1"]
    bad_vector = [0.1] * 1024
    bad_vector[10] = float("nan")
    embedding_service.embed_texts = AsyncMock(return_value=[bad_vector])

    handler = EmbeddingStageHandler(embedding_service=embedding_service)

    with pytest.raises(StageExecutionError) as exc_info:
        await handler.generate_embeddings(full_text="Sample text")

    err = exc_info.value
    assert err.stage == "EMBEDDING"
    assert err.error_code == "EMBEDDING_VECTOR_NON_FINITE"


@pytest.mark.asyncio
async def test_embedding_stage_empty_text():
    embedding_service = MagicMock(spec=EmbeddingService)
    embedding_service.expected_dim = 1024
    handler = EmbeddingStageHandler(embedding_service=embedding_service)

    result = await handler.generate_embeddings(full_text="   \n  ")
    assert result["embeddingsGenerated"] is True
    assert result["chunkCount"] == 0
    assert result["chunks"] == []
    embedding_service.embed_texts.assert_not_called()
