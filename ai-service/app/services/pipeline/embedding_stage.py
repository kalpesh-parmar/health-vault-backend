from __future__ import annotations

import logging
import math
from typing import Any
from uuid import UUID

from app.core.errors import StageExecutionError
from app.modules.embeddings.service import EmbeddingService

logger = logging.getLogger(__name__)


class EmbeddingStageHandler:
    """Stage 9: EMBEDDING.
    Chunks text passages (<= 8192 tokens), generates dense vector embeddings,
    and returns chunk records ready for RAG indexing.
    """

    def __init__(self, embedding_service: EmbeddingService) -> None:
        self.embeddings = embedding_service

    async def generate_embeddings(
        self,
        full_text: str,
        patient_id: UUID | None = None,
        document_id: UUID | None = None,
        max_chunk_chars: int = 1500,
        overlap: int = 200,
    ) -> dict[str, Any]:
        logger.info("Generating token-aware chunk embeddings for document RAG...")
        if not full_text or not full_text.strip():
            logger.info("No text content for embedding; returning 0 chunks")
            return {
                "embeddingsGenerated": True,
                "chunkCount": 0,
                "chunks": [],
                "vectorDimension": 0,
            }

        # Chunk text with overlap
        chunks = self.embeddings.chunk_text(
            full_text, max_chars=max_chunk_chars, overlap=overlap
        )
        chunks = [c.strip() for c in chunks if c and c.strip()]
        if not chunks:
            clean_slice = full_text[:max_chunk_chars].strip()
            chunks = [clean_slice] if clean_slice else []

        if not chunks:
            return {
                "embeddingsGenerated": True,
                "chunkCount": 0,
                "chunks": [],
                "vectorDimension": 0,
            }

        # Generate dense vectors - NO synthetic zero-vector fallback
        expected_dim = getattr(self.embeddings, "expected_dim", 1024)
        try:
            vectors = await self.embeddings.embed_texts(chunks)
        except Exception as exc:
            logger.error("BGE-M3 embedding generation failed: %s", exc, exc_info=True)
            raise StageExecutionError(
                message=f"BGE-M3 embedding service failed: {exc}",
                stage="EMBEDDING",
                error_code="EMBEDDING_FAILED",
                retryable=True,
                details={"error": str(exc), "chunk_count": len(chunks)},
            ) from exc

        # Strict validation of vector dimensions and finite values
        if len(vectors) != len(chunks):
            raise StageExecutionError(
                message=f"Embedding vector count mismatch: generated {len(vectors)} vectors for {len(chunks)} chunks",
                stage="EMBEDDING",
                error_code="EMBEDDING_COUNT_MISMATCH",
                retryable=True,
            )

        for idx, vec in enumerate(vectors):
            if not isinstance(vec, list) or len(vec) != expected_dim:
                actual_dim = len(vec) if isinstance(vec, list) else 0
                raise StageExecutionError(
                    message=f"Invalid embedding dimension at chunk {idx}: expected {expected_dim}, got {actual_dim}",
                    stage="EMBEDDING",
                    error_code="EMBEDDING_DIMENSION_MISMATCH",
                    retryable=True,
                )
            if not all(isinstance(v, (int, float)) and math.isfinite(v) for v in vec):
                raise StageExecutionError(
                    message=f"Non-finite or invalid float value detected in embedding vector at chunk {idx}",
                    stage="EMBEDDING",
                    error_code="EMBEDDING_VECTOR_NON_FINITE",
                    retryable=True,
                )

        dim = expected_dim
        chunk_records = []
        for idx, (chunk_text, vector) in enumerate(zip(chunks, vectors)):
            chunk_records.append(
                {
                    "chunkIndex": idx,
                    "patientId": str(patient_id) if patient_id else None,
                    "documentId": str(document_id) if document_id else None,
                    "text": chunk_text,
                    "vector": vector,
                    "tokenEstimate": max(1, len(chunk_text) // 4),
                    "charCount": len(chunk_text),
                }
            )

        logger.info(
            "Embedding generation completed: %d chunks created (dim=%d)",
            len(chunk_records),
            dim,
        )

        return {
            "embeddingsGenerated": True,
            "chunkCount": len(chunk_records),
            "chunks": chunk_records,
            "vectorDimension": dim,
        }
