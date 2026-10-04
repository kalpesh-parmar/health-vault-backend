from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from app.settings import Settings


def test_lifespan_settings_defaults():
    settings = Settings(
        database_url="postgresql://user:pass@localhost:5432/db",
        ai_model="llama3",
        ai_base_url="http://localhost:11434",
        storage_provider="s3",
        patient_documents_bucket="test-bucket",
        aws_region="us-east-1",
    )
    assert settings.lifespan_warmup_enabled is True
    assert settings.lifespan_warmup_ocr_languages == ["en", "devanagari", "ta"]
    assert settings.ollama_keep_alive == "15m"
    assert settings.validation_max_image_side == 1200


def test_lifespan_settings_csv_parsing():
    settings = Settings(
        database_url="postgresql://user:pass@localhost:5432/db",
        ai_model="llama3",
        ai_base_url="http://localhost:11434",
        storage_provider="s3",
        patient_documents_bucket="test-bucket",
        aws_region="us-east-1",
        lifespan_warmup_ocr_languages="en,devanagari,ta,te",  # type: ignore[arg-type]
    )
    assert settings.lifespan_warmup_ocr_languages == ["en", "devanagari", "ta", "te"]


@pytest.mark.asyncio
async def test_paddle_ocr_engine_warm_up():
    from app.modules.ocr.paddle_engine import PaddleOcrEngine

    mock_future = MagicMock()
    mock_future.result.return_value = (None, 10, "cpu", {})

    mock_executor = MagicMock()
    mock_executor.submit.return_value = mock_future

    with patch.object(PaddleOcrEngine, "_get_active_executor", return_value=mock_executor):
        engine = PaddleOcrEngine.__new__(PaddleOcrEngine)
        engine.lang = "en"
        engine.max_workers = 2
        engine._init_error = None
        engine._device = "cpu"

        result = engine.warm_up(["en", "devanagari"])
        assert result["status"] == "ok"
        assert "en" in result["details"]
        assert "devanagari" in result["details"]
        assert mock_executor.submit.call_count == 4  # 2 langs * 2 workers


@pytest.mark.asyncio
async def test_container_start_warmup_orchestration():
    from app.container import Container

    settings = Settings(
        database_url="postgresql://user:pass@localhost:5432/db",
        ai_model="llama3",
        ai_base_url="http://localhost:11434",
        storage_provider="s3",
        patient_documents_bucket="test-bucket",
        aws_region="us-east-1",
        lifespan_warmup_enabled=True,
        lifespan_warmup_ocr_languages=["en", "ta"],
        ollama_keep_alive="15m",
    )

    with patch("app.container.Database"), \
         patch("app.container.build_llm_service"), \
         patch("app.container.S3StorageClient"), \
         patch("app.container.VisionModelService"), \
         patch("app.container.OcrService"), \
         patch("app.container.SummaryService"), \
         patch("app.container.DocumentAiService"), \
         patch("app.container.ExtractionService"), \
         patch("app.container.RagService"), \
         patch("app.container.ChatService"), \
         patch("app.container.LanguageDetectionService"), \
         patch("app.modules.ocr.paddle_engine.PaddleOcrEngine.get_instance"):

        container = Container(settings)
        container.paddle_ocr.async_warm_up = AsyncMock(return_value={"status": "ok"})
        container.vision.warm_up = AsyncMock()
        container.translation.warm_up = AsyncMock()
        container.language_detection.warm_up = AsyncMock()
        container.models.embeddings.warmup = AsyncMock()
        container._prewarm_ollama_models = AsyncMock()

        await container.start()

        container.paddle_ocr.async_warm_up.assert_awaited_once_with(["en", "ta"])
        container._prewarm_ollama_models.assert_awaited_once()
        container.vision.warm_up.assert_awaited_once()
        container.translation.warm_up.assert_awaited_once()
        container.language_detection.warm_up.assert_awaited_once()
        container.models.embeddings.warmup.assert_awaited_once()
