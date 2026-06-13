from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(tags=["embeddings"])


class EmbeddingRequest(BaseModel):
    text: str


@router.post("/embeddings")
async def embed(payload: EmbeddingRequest, request: Request) -> dict:
    vector = await request.app.state.container.models.embeddings.embed_text(payload.text)
    return {"success": True, "embedding": vector}
