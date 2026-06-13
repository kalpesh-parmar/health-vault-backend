from __future__ import annotations

from uuid import UUID

from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    user_id: UUID = Field(alias="userId")
    message: str
    document_id: UUID | None = Field(default=None, alias="documentId")
    session_id: str | None = Field(default=None, alias="sessionId")
    retrieved_chunks: list[dict] | None = Field(default=None, alias="retrievedChunks")
    history: list[dict] | None = None

    class Config:
        populate_by_name = True
