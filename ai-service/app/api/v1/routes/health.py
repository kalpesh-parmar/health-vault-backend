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

    paddle_engine = getattr(container, "paddle_ocr", None)
    paddle_available = bool(paddle_engine and paddle_engine.is_available())
    paddle_error = str(paddle_engine._init_error) if (paddle_engine and paddle_engine._init_error) else None
    paddle_device = getattr(paddle_engine, "device", "unknown") if paddle_engine else "unknown"
    paddle_mkldnn = getattr(paddle_engine, "enable_mkldnn", False) if paddle_engine else False
    paddle_bypass_orientation = getattr(paddle_engine, "bypass_orientation", True) if paddle_engine else True
    paddle_cpu_threads = getattr(paddle_engine, "cpu_threads", 4) if paddle_engine else 4

    return {
        "success": True,
        "service": "unified-ai",
        "database": database,
        "llm": {
            **llm_status,
            "active_model": settings.ai_model,
            "fallback_provider": None,
        },
        "engines": {
            "paddleocr": {
                "available": paddle_available,
                "error": paddle_error,
                "device": paddle_device,
                "mkldnn": paddle_mkldnn,
                "bypass_orientation": paddle_bypass_orientation,
                "cpu_threads": paddle_cpu_threads,
            }
        },
        "ocr": container.ocr.status(),
        "storage": {
            "provider": container.storage_provider,
            "bucket": settings.effective_gcp_bucket if container.storage_provider == "gcp" else settings.patient_documents_bucket,
        },
        "embedding": {
            "loaded": container.models.embeddings.is_ready,
            "model": container.models.embeddings.model_name,
            "dimension": getattr(container.models.embeddings, "expected_dim", 1024),
        },
    }
