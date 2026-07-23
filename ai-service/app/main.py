from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.v1.routes import chat, embeddings, extraction, health, ocr, rag, summary, voice, translation
from app.core.errors import install_exception_handlers
from app.core.lifecycle import lifespan
from app.settings import get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    app = FastAPI(title=settings.app_name, version="1.0.0", lifespan=lifespan)
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
    install_exception_handlers(app)
    app.include_router(health.router, prefix="/v1")
    app.include_router(ocr.router, prefix="/v1")
    app.include_router(summary.router, prefix="/v1")
    app.include_router(extraction.router, prefix="/v1")
    app.include_router(embeddings.router, prefix="/v1")
    app.include_router(chat.router, prefix="/v1")
    app.include_router(rag.router, prefix="/v1")
    app.include_router(voice.router, prefix="/v1")
    app.include_router(translation.router, prefix="/api/v1")
    return app


app = create_app()