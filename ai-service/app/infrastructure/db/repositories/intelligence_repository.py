from __future__ import annotations

"""Intelligence repository: chat history, vector search, patient context.

The `patient_context` method was removed in a previous partial refactor,
which broke the `RagService.retrieve()` call chain at runtime
(`AttributeError: 'IntelligenceRepository' object has no attribute
'patient_context'`). It is restored here with the original camelCase
contract so the chat prompt builder, the RAG layer, and the existing
frontend response shape continue working without changes.

The repository keeps the async SQLAlchemy 2.0 patterns used elsewhere in
the AI service (`select()` + `await session.scalar(...)` /
`await session.execute(text(...))`).
"""

import uuid
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.db.models import ChatHistory, Patient


class IntelligenceRepository:
    """Data-access layer for AI/RAG flows.

    Methods are intentionally narrow and async. They never own session
    lifecycle — the caller is responsible for `commit()` / `rollback()` —
    so the same instance is safe to reuse inside a single request.
    """

    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    # ── Patient enrichment ────────────────────────────────────────────────

    async def patient_context(self, user_id: uuid.UUID) -> dict[str, Any] | None:
        """Return the minimal patient profile the RAG prompt needs.

        Output shape (camelCase, FE-compatible) is identical to the
        pre-refactor contract so neither `chat_messages` nor any FE
        consumer needs to change. Returns ``None`` when the patient is
        soft-deleted or does not exist.
        """
        stmt = select(Patient).where(
            Patient.id == user_id,
            Patient.soft_delete.is_(False),
        )
        patient = await self.session.scalar(stmt)
        if patient is None:
            return None

        return {
            "patientCode": patient.patient_code,
            "fullName": patient.full_name,
            "gender": patient.gender,
            "age": patient.age,
            "phone": patient.phone,
            "mobile": patient.mobile,
            "email": patient.email,
        }

    # ── Chat history ──────────────────────────────────────────────────────

    async def recent_chat_history(
        self,
        user_id: uuid.UUID,
        session_id: str | None,
        limit: int = 8,
    ) -> list[dict]:
        stmt = (
            select(ChatHistory)
            .where(ChatHistory.user_id == user_id)
            .order_by(ChatHistory.created_at.desc())
            .limit(limit)
        )
        if session_id:
            stmt = stmt.where(ChatHistory.session_id == session_id)

        rows = (await self.session.scalars(stmt)).all()

        return [
            {
                "userMessage": row.user_message,
                "aiResponse": row.ai_response,
                "createdAt": row.created_at.isoformat() if row.created_at else None,
            }
            for row in rows
        ]

    async def create_chat_history(self, data: dict[str, Any]) -> None:
        self.session.add(ChatHistory(**data))
        await self.session.flush()

    # ── Vector search (pgvector) ──────────────────────────────────────────

    async def search_similar_chunks(
        self,
        *,
        user_id: uuid.UUID,
        query_embedding: list[float],
        limit: int,
        document_id: uuid.UUID | None = None,
    ) -> list[dict]:
        vector_literal = "[" + ",".join(f"{float(value):.8f}" for value in query_embedding) + "]"

        params: dict[str, Any] = {
            "user_id": str(user_id),
            "query_embedding": vector_literal,
            "limit": limit,
        }

        document_filter = ""
        if document_id:
            document_filter = "AND dc.document_id = :document_id"
            params["document_id"] = str(document_id)

        result = await self.session.execute(
            text(
                f"""
                SELECT
                    dc.id AS chunk_id,
                    dc.document_id,
                    dc.section_title,
                    dc.content,
                    dc.metadata,
                    dc.source_type,
                    e.embedding <=> CAST(:query_embedding AS vector) AS distance
                FROM embeddings e
                JOIN document_chunks dc
                    ON dc.id = e.chunk_id
                WHERE e.user_id = CAST(:user_id AS uuid)
                {document_filter}
                ORDER BY
                    e.embedding <=> CAST(:query_embedding AS vector)
                LIMIT :limit
                """
            ),
            params,
        )

        return [dict(row._mapping) for row in result.fetchall()]
