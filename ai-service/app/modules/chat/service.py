from __future__ import annotations

"""Chat service.

Adds a single, mandatory existence check on the patient before either
generation path runs. Without it, the FK
`chat_history.user_id → patients.id` blows up at flush time and Postgres
returns a 500 — exactly what was happening in production.

The check is also defensive against the realistic failure mode where the
upstream Node backend issues a JWT-derived `user_id` for a patient that
has been hard-deleted (or never existed). Returning a deterministic 404
is far better than letting the request 500 inside SQLAlchemy.
"""

import logging
import uuid
from collections.abc import AsyncIterator

from app.core.errors import NotFoundError
from app.infrastructure.db.repositories.intelligence_repository import IntelligenceRepository
from app.infrastructure.db.repositories.medication_repository import MedicationRepository
from app.modules.chat.prompts import chat_messages
from app.modules.rag.service import RagService
from app.services.llm import LLMService
from app.services.llm.service import LLMModelError

logger = logging.getLogger(__name__)


class ChatService:
    def __init__(self, llm: LLMService, rag: RagService, chat_model: str) -> None:
        self.llm = llm
        self.rag = rag
        self.chat_model = chat_model

    async def _require_patient(
        self,
        *,
        user_id: uuid.UUID,
        intelligence_repo: IntelligenceRepository,
    ) -> dict:
        """Return the patient row or raise 404.

        We always need this row before persisting chat history, otherwise
        the FK to `patients.id` rejects the INSERT. Calling it early also
        gives us the patient object we can hand straight to the RAG layer
        without a second round-trip.
        """
        patient = await intelligence_repo.patient_context(user_id)
        if patient is None:
            logger.warning(
                "chat_patient_missing",
                extra={"user_id": str(user_id)},
            )
            raise NotFoundError(
                "Patient profile not found for the authenticated user",
                details={"userId": str(user_id)},
            )
        return patient

    async def answer(
        self,
        *,
        user_id: uuid.UUID,
        message: str,
        intelligence_repo: IntelligenceRepository,
        medication_repo: MedicationRepository,
        document_id: uuid.UUID | None = None,
        session_id: str | None = None,
        retrieved_chunks: list[dict] | None = None,
        history: list[dict] | None = None,
    ) -> dict:
        logger.info("chat_service_answer_start", extra={
            "user_id": str(user_id),
            "message_preview": message[:100],
            "document_id": str(document_id) if document_id else None,
            "session_id": session_id,
        })

        # Check patient exists
        patient = await self._require_patient(user_id=user_id, intelligence_repo=intelligence_repo)
        logger.info("chat_service_patient_found", extra={
            "user_id": str(user_id),
            "patient_code": patient.get("patientCode"),
        })


        # Retrieve context unless a trusted upstream caller has already
        # performed scoped vector search and supplied the exact chunks.
        if retrieved_chunks is not None:
            context = {
                "patient": patient,
                "medications": await medication_repo.active_medications(user_id),
                "reminders": await medication_repo.reminders(user_id),
                "history": history or [],
                "retrievedChunks": [_normalize_citation(chunk) for chunk in retrieved_chunks],
            }
        else:
            context = await self.rag.retrieve(
                user_id=user_id,
                message=message,
                intelligence_repo=intelligence_repo,
                medication_repo=medication_repo,
                document_id=document_id,
                session_id=session_id,
            )
        logger.info("chat_service_retrieve_done", extra={
            "user_id": str(user_id),
            "retrieved_chunks": len(context.get("retrievedChunks", [])),
            "patient_context": bool(context.get("patient")),
            "medications": len(context.get("medications", [])),
            "history": len(context.get("history", [])),
        })

        # Call LLM
        logger.info("chat_service_llm_call_start", extra={
            "user_id": str(user_id),
            "model": self.chat_model,
        })
        answer = await self.llm.chat(
            model=self.chat_model,
            messages=chat_messages(message, context),
            temperature=0.2,
        )
        logger.info("chat_service_llm_call_done", extra={
            "user_id": str(user_id),
            "answer_length": len(answer) if answer else 0,
            "answer_preview": answer[:100] if answer else None,
        })

        # Validate answer is not empty
        if not answer or not isinstance(answer, str) or not answer.strip():
            logger.error("chat_service_empty_answer", extra={
                "user_id": str(user_id),
                "answer": answer,
                "answer_type": type(answer).__name__,
            })
            raise LLMModelError("Configured AI model returned an empty chat response")

        response = {
            "answer": answer,
            "confidence": "medium",
            "citations": context["retrievedChunks"],
            "safetyNotes": [],
        }
        await intelligence_repo.create_chat_history(
            {
                "user_id": user_id,
                "document_id": document_id,
                "session_id": session_id,
                "user_message": message,
                "ai_response": response,
                "citations": context["retrievedChunks"],
                "metadata_": {
                    "retrievedChunkIds": [str(chunk["chunk_id"]) for chunk in context["retrievedChunks"]],
                },
            }
        )
        return response

    async def stream_answer(
        self,
        *,
        user_id: uuid.UUID,
        message: str,
        intelligence_repo: IntelligenceRepository,
        medication_repo: MedicationRepository,
        document_id: uuid.UUID | None = None,
        session_id: str | None = None,
        retrieved_chunks: list[dict] | None = None,
        history: list[dict] | None = None,
    ) -> AsyncIterator[str]:
        patient = await self._require_patient(user_id=user_id, intelligence_repo=intelligence_repo)

        if retrieved_chunks is not None:
            context = {
                "patient": patient,
                "medications": await medication_repo.active_medications(user_id),
                "reminders": await medication_repo.reminders(user_id),
                "history": history or [],
                "retrievedChunks": [_normalize_citation(chunk) for chunk in retrieved_chunks],
            }
        else:
            context = await self.rag.retrieve(
                user_id=user_id,
                message=message,
                intelligence_repo=intelligence_repo,
                medication_repo=medication_repo,
                document_id=document_id,
                session_id=session_id,
            )
        parts: list[str] = []
        async for token in self.llm.stream_chat(
            model=self.chat_model,
            messages=chat_messages(message, context),
            temperature=0.2,
        ):
            parts.append(token)
            yield token

        response = {
            "answer": "".join(parts),
            "confidence": "medium",
            "citations": context["retrievedChunks"],
            "safetyNotes": [],
        }
        await intelligence_repo.create_chat_history(
            {
                "user_id": user_id,
                "document_id": document_id,
                "session_id": session_id,
                "user_message": message,
                "ai_response": response,
                "citations": context["retrievedChunks"],
                "metadata_": {
                    "retrievedChunkIds": [str(chunk["chunk_id"]) for chunk in context["retrievedChunks"]],
                },
            }
        )


def _normalize_citation(chunk: dict) -> dict:
    normalized = dict(chunk or {})
    if "chunk_id" not in normalized and normalized.get("chunkId"):
        normalized["chunk_id"] = normalized["chunkId"]
    if "section_title" not in normalized and normalized.get("sectionTitle"):
        normalized["section_title"] = normalized["sectionTitle"]
    if "source_type" not in normalized and normalized.get("sourceType"):
        normalized["source_type"] = normalized["sourceType"]
    return normalized
