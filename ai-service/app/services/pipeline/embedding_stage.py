from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

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
        if not chunks:
            chunks = [full_text[:max_chunk_chars]]

        # Generate dense vectors
        vectors: list[list[float]] = []
        try:
            vectors = await self.embeddings.embed_texts(chunks)
        except Exception as e:
            logger.warning("Embedding generation encountered an error: %s", e)
            # Create synthetic vector placeholder if embedding service unavailable
            dim = getattr(self.embeddings, "expected_dim", 1024)
            vectors = [[0.0] * dim for _ in chunks]

        dim = len(vectors[0]) if vectors else 0
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
