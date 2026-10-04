import asyncio
import json
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from app.services.ai_client import (
    AiClientConfig,
    ChatCompletionsClient,
    GenerationResult,
)


def test_generation_result_unpacking_and_telemetry():
    """Verify GenerationResult behaves as a standard 2-tuple while carrying telemetry."""
    telemetry = {"encode_ms": 14, "http_network_ms": 420, "ollama_total_ms": 52100}
    result = GenerationResult('{"text": "report"}', "stop", telemetry)

    # Must unpack into exactly 2 values for backward compatibility
    text, finish_reason = result
    assert text == '{"text": "report"}'
    assert finish_reason == "stop"
    assert len(result) == 2
    assert result[0] == '{"text": "report"}'
    assert result[1] == "stop"

    # Telemetry accessible via property
    assert result.telemetry == telemetry
    assert result.telemetry["encode_ms"] == 14
    assert result.telemetry["http_network_ms"] == 420


@pytest.mark.asyncio
async def test_ollama_vision_telemetry_extraction():
    """Verify Ollama native nanosecond durations are converted to ms and telemetry is computed."""
    config = AiClientConfig(
        api_key="",
        base_url="http://192.168.21.176:11434",
        model="qwen3-vl:latest",
        timeout_seconds=60.0,
        max_retries=1,
        max_output_tokens=1024,
    )
    client = ChatCompletionsClient(config)

    mock_ollama_resp = {
        "model": "qwen3-vl:latest",
        "created_at": "2026-09-24T12:00:00Z",
        "message": {"role": "assistant", "content": '{"pages":[{"page":1,"text":"CBC normal"}]}'},
        "done": True,
        "done_reason": "stop",
        "total_duration": 52577000000,       # 52,577 ms
        "load_duration": 1500000000,         # 1,500 ms
        "prompt_eval_count": 1240,
        "prompt_eval_duration": 35000000000, # 35,000 ms
        "eval_count": 352,
        "eval_duration": 16000000000,        # 16,000 ms (352 / 16.0 = 22.0 tok/s)
    }

    mock_http_resp = MagicMock()
    mock_http_resp.status_code = 200
    mock_http_resp.content = json.dumps(mock_ollama_resp).encode("utf-8")
    mock_http_resp.json.return_value = mock_ollama_resp

    mock_async_client = AsyncMock()
    mock_async_client.post.return_value = mock_http_resp

    with patch.object(client, "_ensure_http_client", return_value=mock_async_client):
        res = await client.generate_json_from_bytes(
            data=b"dummy_image_bytes_for_telemetry_test",
            mime_type="image/jpeg",
            prompt="OCR prompt",
        )

        assert isinstance(res, GenerationResult)
        assert res.telemetry is not None

        tel = res.telemetry
        assert tel["ollama_total_ms"] == 52577
        assert tel["ollama_load_ms"] == 1500
        assert tel["ollama_prompt_eval_count"] == 1240
        assert tel["ollama_prompt_eval_ms"] == 35000
        assert tel["ollama_eval_count"] == 352
        assert tel["ollama_eval_ms"] == 16000
        assert tel["tokens_per_sec"] == 22.0
        assert "encode_ms" in tel
        assert "http_network_ms" in tel
        assert "decode_ms" in tel
        assert client.last_telemetry == tel


def test_cer_and_accuracy_algorithms():
    """Verify CER computation with Levenshtein distance on known ground truth pairs."""
    import sys
    from pathlib import Path
    repo_root = str(Path(__file__).resolve().parents[4])
    if repo_root not in sys.path:
        sys.path.insert(0, repo_root)
    from scripts.benchmark_ocr import compute_cer, compute_field_accuracy

    # Identical strings
    assert compute_cer("Hemoglobin: 13.5 g/dL", "Hemoglobin: 13.5 g/dL") == 0.0

    # 1 substitution in 10 characters -> 0.1
    assert compute_cer("abcdefghij", "abcdefghik") == 0.1

    # Empty vs non-empty
    assert compute_cer("", "") == 0.0
    assert compute_cer("something", "") == 1.0
    assert compute_cer("", "something") == 1.0

    # Field accuracy matching across sections
    gt_json = {
        "patientInfo": {"name": "John Doe", "age": "45"},
        "labResults": [
            {"testName": "Hemoglobin", "value": "14.2"},
            {"testName": "Platelets", "value": "250000"},
        ],
    }
    extracted_json = {
        "patientInfo": {"name": "John Doe", "age": "45"},
        "labResults": [
            {"testName": "Hemoglobin", "value": "14.2 g/dL"},
            {"testName": "Platelet Count", "value": "250000"},
        ],
    }

    acc = compute_field_accuracy(gt_json, extracted_json)
    assert acc["patient_accuracy"] == 1.0
    assert acc["lab_concordance"] == 1.0
    assert acc["overall_accuracy"] == 1.0