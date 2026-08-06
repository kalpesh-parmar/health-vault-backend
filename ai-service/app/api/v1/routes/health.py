from __future__ import annotations

from sqlalchemy import text
from fastapi import APIRouter, Request

router = APIRouter(tags=["health"])


@router.get("/health")
async def health(request: Request) -> dict:
    container = request.app.state.container
    settings = container.settings

    database = {"ok": False}
    try:
        async with container.db.session_factory() as session:
            await session.execute(text("SELECT 1"))
            database = {"ok": True}
    except Exception as exc:
        database = {"ok": False, "error": str(exc)}

    llm_status = await container.llm.health()

    return {
        "success": True,
        "service": "unified-ai",
        "database": database,
        "llm": {
            **llm_status,
            "active_model": settings.ai_model,
            "fallback_provider": None,
        },
        "ocr": container.ocr.status(),
        "storage": {
            "provider": container.storage_provider,
            "bucket": settings.effective_gcp_bucket if container.storage_provider == "gcp" else settings.patient_documents_bucket,
        },
        "embedding": {
            "loaded": container.models.embeddings.model is not None,
            "model": container.models.embeddings.model_name,
        },
    }
