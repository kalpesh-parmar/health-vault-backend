from __future__ import annotations

import logging
import uuid
import re

from app.infrastructure.db.repositories.intelligence_repository import IntelligenceRepository
from app.infrastructure.db.repositories.medication_repository import MedicationRepository
from app.modules.embeddings.service import EmbeddingService

logger = logging.getLogger(__name__)


class RagService:
    def __init__(self, embeddings: EmbeddingService, top_k: int) -> None:
        self.embeddings = embeddings
        self.top_k = top_k

    async def retrieve(
        self,
        *,
        user_id: uuid.UUID,
        message: str,
        intelligence_repo: IntelligenceRepository,
        medication_repo: MedicationRepository,
        document_id: uuid.UUID | None = None,
        session_id: str | None = None,
    ) -> dict:
        logger.info("rag_retrieve_start", extra={
            "user_id": str(user_id),
            "message_preview": message[:100] if message else None,
            "document_id": str(document_id) if document_id else None,
            "session_id": session_id,
            "top_k": self.top_k,
        })

        # Generate embedding
        logger.info("rag_generate_embedding")
        query_embedding = await self.embeddings.embed_text(message)
        logger.info("rag_embedding_done", extra={
            "embedding_length": len(query_embedding) if query_embedding else 0,
        })

        # Search chunks
        logger.info("rag_search_chunks_start")
        chunks = await intelligence_repo.search_similar_chunks(
            user_id=user_id,
            query_embedding=query_embedding,
            limit=self.top_k,
            document_id=document_id,
        )
        logger.info("rag_search_chunks_done", extra={
            "chunks_found": len(chunks),
        })
        chunks = rerank_chunks(message, chunks, limit=self.top_k)

        # Get patient context
        logger.info("rag_patient_context_start")
        patient = await intelligence_repo.patient_context(user_id)
        logger.info("rag_patient_context_done", extra={
            "patient_found": patient is not None,
        })

        # Get medications
        logger.info("rag_medications_start")
        medications = await medication_repo.active_medications(user_id)
        logger.info("rag_medications_done", extra={
            "medications_count": len(medications),
        })

        # Get reminders
        logger.info("rag_reminders_start")
        reminders = await medication_repo.reminders(user_id)
        logger.info("rag_reminders_done", extra={
            "reminders_count": len(reminders),
        })

        # Get chat history
        logger.info("rag_chat_history_start")
        history = await intelligence_repo.recent_chat_history(user_id, session_id)
        logger.info("rag_chat_history_done", extra={
            "history_count": len(history),
        })

        result = {
            "patient": patient,
            "medications": medications,
            "reminders": reminders,
            "history": history,
            "retrievedChunks": chunks,
        }

        logger.info("rag_retrieve_complete", extra={
            "user_id": str(user_id),
            "retrieved_chunks": len(chunks),
        })

        return result


def rerank_chunks(message: str, chunks: list[dict], *, limit: int) -> list[dict]:
    query_terms = {
        term.lower()
        for term in re.findall(r"[A-Za-z0-9.]+", message or "")
        if len(term) > 2
    }
    if not query_terms:
        return chunks[:limit]

    def score(chunk: dict) -> tuple[float, float]:
        content = str(chunk.get("content") or "").lower()
        lexical_hits = sum(1 for term in query_terms if term in content)
        distance = float(chunk.get("distance") or 1.0)
        return (lexical_hits, -distance)

    return sorted(chunks, key=score, reverse=True)[:limit]
