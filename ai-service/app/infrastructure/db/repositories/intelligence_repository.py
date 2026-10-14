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

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
import json
import uuid
from typing import Any

from sqlalchemy import select, text
from sqlalchemy.dialects import postgresql
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.db.models import ChatHistory, Patient
from app.infrastructure.db.session import Database


class IntelligenceRepository:
    """Data-access layer for AI/RAG flows.

    Supports both single request-scoped AsyncSession and worker-scoped Database instance.
    """

    def __init__(
        self,
        session: AsyncSession | None = None,
        db: Database | None = None,
    ) -> None:
        self.session = session
        self.db = db

    @asynccontextmanager
    async def _get_session(self) -> AsyncIterator[AsyncSession]:
        if self.session is not None:
            yield self.session
        elif self.db is not None:
            async for s in self.db.session():
                yield s
        else:
            raise RuntimeError("IntelligenceRepository requires either an active AsyncSession or Database instance")

    # ── Patient enrichment ────────────────────────────────────────────────

    async def patient_context(self, user_id: uuid.UUID) -> dict[str, Any] | None:
        """Return the minimal patient profile the RAG prompt needs.

        Output shape (camelCase, FE-compatible) is identical to the
        pre-refactor contract so neither `chat_messages` nor any FE
        consumer needs to change. Returns ``None`` when the patient is
        soft-deleted or does not exist.
        """
        async with self._get_session() as session:
            stmt = select(Patient).where(
                Patient.id == user_id,
                Patient.soft_delete.is_(False),
            )
            patient = await session.scalar(stmt)
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
        limit: int = 2,
    ) -> list[dict]:
        async with self._get_session() as session:
            stmt = (
                select(ChatHistory)
                .where(ChatHistory.user_id == user_id)
                .order_by(ChatHistory.created_at.desc())
                .limit(limit)
            )
            if session_id:
                stmt = stmt.where(ChatHistory.session_id == session_id)

            rows = (await session.scalars(stmt)).all()

            return [
                {
                    "userMessage": row.user_message,
                    "aiResponse": row.ai_response,
                    "createdAt": row.created_at.isoformat() if row.created_at else None,
                }
                for row in rows
            ]

    async def create_chat_history(self, data: dict[str, Any]) -> None:
        async with self._get_session() as session:
            session.add(ChatHistory(**data))
            await session.commit()

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
            document_filter = "AND dc.document_id = CAST(:document_id AS uuid)"
            params["document_id"] = str(document_id)

        async with self._get_session() as session:
            result = await session.execute(
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

    # ── Document Chunks & Embeddings Persistence ──────────────────────────

    async def persist_document_chunks_and_embeddings(
        self,
        *,
        document_id: uuid.UUID | str,
        user_id: uuid.UUID | str | None,
        chunks: list[dict[str, Any]],
        model_name: str = "bge-m3:latest",
        expected_dim: int = 1024,
        source_type: str = "ocr_chunk",
    ) -> tuple[int, int]:
        """Atomically and idempotently persist document chunks and dense embeddings.

        Validates vector dimensions (1024) and finite float values.
        Removes any pre-existing chunks and embeddings for the document before insertion.
        Verifies persisted row counts before committing the transaction.
        """
        import math

        doc_uuid = uuid.UUID(str(document_id))
        target_user_id = uuid.UUID(str(user_id)) if user_id is not None else None

        # Pre-validate chunks and vectors before touching the database
        for idx, chunk in enumerate(chunks):
            chunk_idx = chunk.get("chunkIndex", idx)
            vector = chunk.get("vector")
            if not isinstance(vector, list) or len(vector) != expected_dim:
                actual_len = len(vector) if isinstance(vector, list) else 0
                raise ValueError(
                    f"Vector validation failed at chunk {chunk_idx}: expected dimension {expected_dim}, got {actual_len}"
                )
            for v_idx, val in enumerate(vector):
                if not isinstance(val, (int, float)) or not math.isfinite(val):
                    raise ValueError(
                        f"Vector validation failed at chunk {chunk_idx}, element {v_idx}: non-finite or invalid float '{val}'"
                    )

        async with self._get_session() as session:
            try:
                # If target_user_id is None, resolve from documents table
                if target_user_id is None:
                    doc_owner = (
                        await session.execute(
                            text("SELECT user_id FROM documents WHERE id = CAST(:doc_id AS uuid)"),
                            {"doc_id": str(doc_uuid)},
                        )
                    ).scalar()
                    if not doc_owner:
                        raise ValueError(f"Cannot persist chunks: patient user_id not found for document {doc_uuid}")
                    target_user_id = uuid.UUID(str(doc_owner))

                # 1. Idempotency cleanup: delete existing chunks and embeddings
                await session.execute(
                    text(
                        """
                        DELETE FROM embeddings
                        WHERE source_id = CAST(:document_id AS uuid)
                          AND source_type = CAST(:source_type AS ai_source_type)
                        """
                    ),
                    {"document_id": str(doc_uuid), "source_type": source_type},
                )
                await session.execute(
                    text(
                        """
                        DELETE FROM document_chunks
                        WHERE document_id = CAST(:document_id AS uuid)
                          AND source_type = CAST(:source_type AS ai_source_type)
                        """
                    ),
                    {"document_id": str(doc_uuid), "source_type": source_type},
                )

                if not chunks:
                    await session.commit()
                    return (0, 0)

                # 2. Insert document_chunks and embeddings
                insert_chunk_stmt = text(
                    """
                    INSERT INTO document_chunks (
                        id, document_id, user_id, chunk_index, content, metadata,
                        token_estimate, source_type, section_title
                    ) VALUES (
                        CAST(:id AS uuid), CAST(:document_id AS uuid), CAST(:user_id AS uuid),
                        :chunk_index, :content, CAST(:metadata AS jsonb),
                        :token_estimate, CAST(:source_type AS ai_source_type), :section_title
                    )
                    """
                )

                insert_embedding_stmt = text(
                    """
                    INSERT INTO embeddings (
                        id, chunk_id, user_id, source_type, source_id,
                        embedding, model, metadata
                    ) VALUES (
                        CAST(:id AS uuid), CAST(:chunk_id AS uuid), CAST(:user_id AS uuid),
                        CAST(:source_type AS ai_source_type), CAST(:source_id AS uuid),
                        CAST(:embedding AS vector), :model, CAST(:metadata AS jsonb)
                    )
                    """
                )

                for idx, chunk in enumerate(chunks):
                    chunk_id = uuid.uuid4()
                    embedding_id = uuid.uuid4()
                    content = str(chunk.get("text") or chunk.get("content") or "")
                    chunk_index = int(chunk.get("chunkIndex", idx))
                    token_estimate = int(chunk.get("tokenEstimate") or max(1, len(content) // 4))
                    char_count = int(chunk.get("charCount") or len(content))
                    section_title = chunk.get("sectionTitle") or chunk.get("section_title")
                    vector = chunk["vector"]
                    vector_literal = "[" + ",".join(f"{float(val):.8f}" for val in vector) + "]"
                    meta = {
                        "chunk_index": chunk_index,
                        "token_estimate": token_estimate,
                        "char_count": char_count,
                        "document_id": str(doc_uuid),
                    }
                    if chunk.get("metadata") and isinstance(chunk["metadata"], dict):
                        meta.update(chunk["metadata"])

                    await session.execute(
                        insert_chunk_stmt,
                        {
                            "id": str(chunk_id),
                            "document_id": str(doc_uuid),
                            "user_id": str(target_user_id),
                            "chunk_index": chunk_index,
                            "content": content,
                            "metadata": json.dumps(meta),
                            "token_estimate": token_estimate,
                            "source_type": source_type,
                            "section_title": section_title,
                        },
                    )

                    await session.execute(
                        insert_embedding_stmt,
                        {
                            "id": str(embedding_id),
                            "chunk_id": str(chunk_id),
                            "user_id": str(target_user_id),
                            "source_type": source_type,
                            "source_id": str(doc_uuid),
                            "embedding": vector_literal,
                            "model": model_name,
                            "metadata": json.dumps({"token_estimate": token_estimate, "chunk_index": chunk_index}),
                        },
                    )

                # 3. Verify persisted counts in this transaction
                count_chunks_res = await session.execute(
                    text(
                        """
                        SELECT COUNT(*) FROM document_chunks
                        WHERE document_id = CAST(:document_id AS uuid)
                          AND source_type = CAST(:source_type AS ai_source_type)
                        """
                    ),
                    {"document_id": str(doc_uuid), "source_type": source_type},
                )
                persisted_chunk_count = count_chunks_res.scalar() or 0

                count_embeddings_res = await session.execute(
                    text(
                        """
                        SELECT COUNT(*) FROM embeddings
                        WHERE source_id = CAST(:document_id AS uuid)
                          AND source_type = CAST(:source_type AS ai_source_type)
                        """
                    ),
                    {"document_id": str(doc_uuid), "source_type": source_type},
                )
                persisted_embedding_count = count_embeddings_res.scalar() or 0

                if persisted_chunk_count != len(chunks) or persisted_embedding_count != len(chunks):
                    raise RuntimeError(
                        f"Chunk persistence count mismatch: expected {len(chunks)} chunks & embeddings, "
                        f"but found {persisted_chunk_count} chunks and {persisted_embedding_count} embeddings."
                    )

                await session.commit()
                return (persisted_chunk_count, persisted_embedding_count)

            except Exception:
                await session.rollback()
                raise
