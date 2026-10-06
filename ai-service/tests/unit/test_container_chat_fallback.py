from unittest.mock import MagicMock
from app.container import Container
from app.settings import Settings


def test_container_chat_and_extraction_fallback_to_medgemma():
    settings = Settings(
        AI_MODEL="qwen3-vl:latest",
        AI_BASE_URL="http://localhost:11434",
        CHAT_MODEL=None,  # Explicitly unset
        MEDGEMMA_MODEL="medgemma:4b",
    )
    assert settings.chat_model is None
    assert settings.medgemma_model == "medgemma:4b"

    # Verify that container resolves chat_model to medgemma:4b
    resolved_chat_model = settings.chat_model or settings.medgemma_model or settings.ai_model
    assert resolved_chat_model == "medgemma:4b"


def test_container_chat_resolves_when_chat_model_set():
    settings = Settings(
        AI_MODEL="qwen3-vl:latest",
        AI_BASE_URL="http://localhost:11434",
        CHAT_MODEL="custom-chat:latest",
        MEDGEMMA_MODEL="medgemma:4b",
    )
    resolved_chat_model = settings.chat_model or settings.medgemma_model or settings.ai_model
    assert resolved_chat_model == "custom-chat:latest"
