from __future__ import annotations

import sys
import pytest
import httpx
from unittest.mock import AsyncMock, patch

from app.modules.embeddings.service import (
    EmbeddingService,
    strip_thinking,
    resolve_ollama_base_url,
)
from app.settings import Settings


def test_no_sentence_transformers_imported():
    """Ensure sentence_transformers is not loaded into sys.modules by embedding service."""
    assert "sentence_transformers" not in sys.modules, (
        "sentence_transformers must not be imported in production embedding flow"
    )


def test_strip_thinking_utility():
    raw = "<think>Translation in progress... Need to convert to English.</think>Patient presents with acute cough."
    assert strip_thinking(raw) == "Patient presents with acute cough."

    nested = "<think>Thought 1</think>Middle<think>Thought 2</think>End."
    assert strip_thinking(nested) == "MiddleEnd."

    no_think = "Standard clinical text without reasoning tags."
    assert strip_thinking(no_think) == no_think

    empty = ""
    assert strip_thinking(empty) == ""


def test_resolve_ollama_base_url():
    assert resolve_ollama_base_url(None) == "http://192.168.21.176:11434"
    assert resolve_ollama_base_url("http://localhost:11434/v1") == "http://localhost:11434"
    assert resolve_ollama_base_url("http://192.168.21.176:11434/") == "http://192.168.21.176:11434"


def test_settings_normalizes_to_bge_m3_latest():
    base_env = {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/health_vault",
        "AI_MODEL": "qwen3-vl:latest",
        "AI_BASE_URL": "http://192.168.21.176:11434",
        "STORAGE_PROVIDER": "s3",
        "PATIENT_DOCUMENTS_BUCKET": "patient-docs",
        "AWS_REGION": "us-east-1",
    }

    # Default should be bge-m3:latest
    s1 = Settings(_env_file=None, **base_env)
    assert s1.embedding_model == "bge-m3:latest"

    # bge-m3 alias should normalize to bge-m3:latest
    s2 = Settings(_env_file=None, AI_EMBEDDING_MODEL="bge-m3", **base_env)
    assert s2.embedding_model == "bge-m3:latest"

    # baai/bge-m3 should normalize to bge-m3:latest, never BAAI/bge-m3
    s3 = Settings(_env_file=None, AI_EMBEDDING_MODEL="baai/bge-m3", **base_env)
    assert s3.embedding_model == "bge-m3:latest"
    assert s3.embedding_model != "BAAI/bge-m3"

    # explicit bge-m3:latest should remain bge-m3:latest
    s4 = Settings(_env_file=None, AI_EMBEDDING_MODEL="bge-m3:latest", **base_env)
    assert s4.embedding_model == "bge-m3:latest"


@pytest.mark.asyncio
async def test_embed_text_via_api_embed():
    service = EmbeddingService(
        base_url="http://192.168.21.176:11434",
        model_name="bge-m3:latest",
    )

    dummy_vector = [0.123] * 1024
    mock_response = httpx.Response(
        status_code=200,
        json={"embeddings": [dummy_vector]},
        request=httpx.Request("POST", "http://192.168.21.176:11434/api/embed"),
    )

    with patch.object(service, "_ensure_client") as mock_ensure:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_ensure.return_value = mock_client

        vector = await service.embed_text("<think>reasoning</think>Blood pressure 120/80 mmHg")

        assert len(vector) == 1024
        assert vector[0] == pytest.approx(0.123)

        # Verify call arguments
        mock_client.post.assert_called_once()
        call_args, call_kwargs = mock_client.post.call_args
        assert call_args[0] == "/api/embed"
        payload = call_kwargs["json"]
        assert payload["model"] == "bge-m3:latest"
        assert payload["input"] == ["Blood pressure 120/80 mmHg"]
        assert payload["keep_alive"] == -1

    await service.close()


@pytest.mark.asyncio
async def test_embed_texts_caching_and_batching():
    service = EmbeddingService(
        base_url="http://192.168.21.176:11434",
        model_name="bge-m3:latest",
        batch_size=2,
    )

    vec1 = [0.1] * 1024
    vec2 = [0.2] * 1024

    mock_response = httpx.Response(
        status_code=200,
        json={"embeddings": [vec1, vec2]},
        request=httpx.Request("POST", "http://192.168.21.176:11434/api/embed"),
    )

    with patch.object(service, "_ensure_client") as mock_ensure:
        mock_client = AsyncMock()
        mock_client.post.return_value = mock_response
        mock_ensure.return_value = mock_client

        # Call with 2 unique texts
        texts = ["Text A", "Text B"]
        results = await service.embed_texts(texts)

        assert len(results) == 2
        assert len(results[0]) == 1024
        assert results[0][0] == pytest.approx(0.1)
        assert results[1][0] == pytest.approx(0.2)
        assert mock_client.post.call_count == 1

        # Repeated call with same texts should hit cache, zero additional HTTP calls
        cached_results = await service.embed_texts(["Text A", "Text B"])
        assert len(cached_results) == 2
        assert mock_client.post.call_count == 1  # Still 1, cache hit!

    await service.close()


@pytest.mark.asyncio
async def test_embed_fallback_to_api_embeddings():
    service = EmbeddingService(
        base_url="http://192.168.21.176:11434",
        model_name="bge-m3:latest",
    )

    # First call to /api/embed returns 404 (simulating older Ollama)
    resp_404 = httpx.Response(
        status_code=404,
        request=httpx.Request("POST", "http://192.168.21.176:11434/api/embed"),
    )
    # Subsequent calls to /api/embeddings return 200
    vec = [0.456] * 1024
    resp_legacy = httpx.Response(
        status_code=200,
        json={"embedding": vec},
        request=httpx.Request("POST", "http://192.168.21.176:11434/api/embeddings"),
    )

    with patch.object(service, "_ensure_client") as mock_ensure:
        mock_client = AsyncMock()
        mock_client.post.side_effect = [resp_404, resp_legacy]
        mock_ensure.return_value = mock_client

        vector = await service.embed_text("Sample fallback text")

        assert len(vector) == 1024
        assert vector[0] == pytest.approx(0.456)
        assert mock_client.post.call_count == 2

    await service.close()


@pytest.mark.asyncio
async def test_empty_text_returns_zeros():
    service = EmbeddingService()
    vector = await service.embed_text("")
    assert len(vector) == 1024
    assert all(v == 0.0 for v in vector)

    blank_vector = await service.embed_text("   \n\t  ")
    assert len(blank_vector) == 1024
    assert all(v == 0.0 for v in blank_vector)
    await service.close()


def test_chunking_contract_preserved():
    service = EmbeddingService()
    text = "Short text."
    chunks = service.chunk_text(text, max_chars=50, overlap=10)
    assert chunks == ["Short text."]

    long_text = "word " * 100
    chunks = service.chunk_text(long_text, max_chars=100, overlap=20)
    assert len(chunks) > 1
    for chunk in chunks:
        assert len(chunk) <= 100
