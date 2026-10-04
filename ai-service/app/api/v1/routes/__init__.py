"""API route modules."""
from . import chat, embeddings, extraction, health, ocr, rag, summary, voice, translation, language, internal_documents

__all__ = [
    "chat",
    "embeddings",
    "extraction",
    "health",
    "ocr",
    "rag",
    "summary",
    "voice",
    "translation",
    "language",
    "internal_documents",
]
