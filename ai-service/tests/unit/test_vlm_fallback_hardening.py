import pytest
from typing import Any
from unittest.mock import AsyncMock, patch

from app.services.pipeline.ocr_stage import OcrStageHandler
from app.services.ai_client import AiClientConfig, ChatCompletionsClient


def test_is_pseudo_latin_noise():
    """Verify that hallucinated pseudo-Latin gibberish is detected and excised, while real text is preserved."""
    # Hallucinated pseudo-Latin patterns emitted by English Paddle on Indic scripts
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "o 1 a n d e r", "confidence": 0.72}) is True
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "A l l r e g", "confidence": 0.81}) is True
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "Eqy qyu xzk", "confidence": 0.65}) is True
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "a b c d e f", "confidence": 0.70}) is True
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "3 4 a t a r", "confidence": 0.68}) is True
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "--- /// ...", "confidence": 0.90}) is True
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "", "confidence": 0.0}) is True
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "random", "confidence": 0.40}) is True

    # Genuine English clinical and document lines must be preserved
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "Patient Name: Rajesh Sharma", "confidence": 0.95}) is False
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "Hemoglobin: 14.2 g/dL", "confidence": 0.92}) is False
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "Date of Collection: 12/04/2026", "confidence": 0.88}) is False
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "BLOOD GLUCOSE FASTING", "confidence": 0.96}) is False
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "REF: 49201948", "confidence": 0.85}) is False

    # Genuine Indic lines must be preserved
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "रक्त परीक्षण रिपोर्ट", "confidence": 0.93}) is False
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "மருத்துவ அறிக்கை", "confidence": 0.91}) is False
    assert OcrStageHandler._is_pseudo_latin_noise({"text": "દર્દીનું નામ", "confidence": 0.90}) is False


def test_deduplicate_lines():
    """Verify bidirectional deduplication between retained lines and incoming VLM lines."""
    base_lines = [
        {"text": "City Hospital Diagnostic Center", "confidence": 0.92},
        {"text": "Patient Name: Rajesh Sharma", "confidence": 0.89},
        {"text": "Age: 45 Yrs / Male", "confidence": 0.94},
    ]

    incoming_lines = [
        # Exact match (different case / spaces)
        {"text": "patient name: rajesh sharma", "confidence": 0.98, "provenance": "vlm_fallback"},
        # Near duplicate (>85% token overlap)
        {"text": "City Hospital Diagnostic Centre", "confidence": 0.96, "provenance": "vlm_fallback"},
        # Completely new non-Latin line
        {"text": "रक्तचाप: १२०/८० mmHg", "confidence": 0.95, "provenance": "vlm_fallback"},
        # Completely new English line
        {"text": "Doctor: Dr. A. K. Gupta", "confidence": 0.95, "provenance": "vlm_fallback"},
    ]

    deduped = OcrStageHandler._deduplicate_lines(base_lines, incoming_lines)

    # Base had 3 lines, incoming had 2 duplicates and 2 new lines -> total should be 5 lines
    assert len(deduped) == 5

    # Check that patient name has updated higher confidence and provenance
    patient_line = next(l for l in deduped if "rajesh" in l["text"].lower())
    assert patient_line["confidence"] == 0.98

    # Check new lines are included
    texts = [l["text"] for l in deduped]
    assert any("रक्तचाप" in t for t in texts)
    assert any("Gupta" in t for t in texts)


def test_apply_vision_result_hybrid_excises_pseudo_latin():
    """Verify that _apply_vision_result removes pseudo-Latin Paddle lines and merges clean VLM output."""
    handler = OcrStageHandler(
        s3_client=None,
        lifecycle=None,
        vision_service=None,
        paddle_engine=None,
        quality_gate=None,
    )

    paddle_res = {
        "lines": [
            {"text": "APOLLO CLINIC", "confidence": 0.95},
            {"text": "o 1 a n d e r", "confidence": 0.75},  # Pseudo-Latin noise
            {"text": "Eqy qyu", "confidence": 0.70},        # Pseudo-Latin noise
            {"text": "Blood Group: O Positive", "confidence": 0.91},
        ],
    }

    vision_res = {
        "text": "દર્દીનું નામ: રાજેશ શર્મા\nઉંમર: ૪૫ વર્ષ\nBlood Group: O Positive",
        "confidence": 0.95,
    }

    page_text, conf, lines, engine_used, status = handler._apply_vision_result(
        res=vision_res,
        paddle_res=paddle_res,
        fallback_reason="UNREAD_NON_LATIN_SCRIPT",
    )

    assert engine_used == "hybrid_paddle_vlm"
    assert status == "FALLBACK"
    assert "APOLLO CLINIC" in page_text
    assert "દર્દીનું નામ: રાજેશ શર્મા" in page_text
    assert "o 1 a n d e r" not in page_text
    assert "Eqy qyu" not in page_text

    # Verify no duplicate "Blood Group" line
    bg_lines = [l for l in lines if "blood group" in l["text"].lower()]
    assert len(bg_lines) == 1

    # Verify provenance on fallback lines
    vlm_lines = [l for l in lines if l.get("provenance") == "vlm_fallback"]
    assert len(vlm_lines) >= 2


@pytest.mark.asyncio
async def test_ollama_payload_suppresses_reasoning():
    """Verify that ChatCompletionsClient injects think: False in Ollama vision chat payload."""
    config = AiClientConfig(
        api_key="mock-key",
        base_url="http://192.168.21.176:11434/v1",
        model="qwen2.5-vl:7b",
        timeout_seconds=10.0,
        max_retries=0,
        max_output_tokens=512,
        num_predict=512,
        num_ctx=2048,
    )
    client = ChatCompletionsClient(config)

    captured_payload = None

    async def mock_post_ollama(payload, mime_type, image_size):
        nonlocal captured_payload
        captured_payload = payload
        return {
            "message": {"content": '{"text": "sample text"}'},
            "done_reason": "stop",
        }

    with patch.object(client, "_post_ollama_vision_chat", side_effect=mock_post_ollama):
        res = await client.generate_json_from_bytes(
            data=b"fake_image_bytes",
            mime_type="image/jpeg",
            prompt="Transcribe text",
        )

    assert captured_payload is not None
    assert captured_payload.get("think") is False
    assert captured_payload["options"]["num_predict"] == 512
    assert captured_payload["options"]["num_ctx"] == 2048
