from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from app.modules.extraction.prompts import structured_document_prompt
from app.modules.extraction.service import ExtractionService
from app.services.ai_client import AiClientConfig, ChatCompletionsClient, build_ai_client
from app.services.llm.service import LLMService, build_llm_service
from app.settings import Settings


def test_structured_prompt_character_reduction():
    """P6-01: Verify prompt template achieves at least 35% character reduction vs legacy baseline (~2340 chars)."""
    raw_ocr = {"fullText": "Patient: Jane Doe, Age: 30. Rx: Amoxicillin 500mg."}
    msgs = structured_document_prompt(raw_ocr)
    user_content = msgs[1]["content"]

    # Template portion excluding the injected dynamic document content
    template_portion = user_content.split("Document Content:")[0].strip()

    # Legacy template was ~2,342 characters
    legacy_len = 2342
    current_len = len(template_portion)

    reduction_pct = (legacy_len - current_len) / legacy_len
    assert reduction_pct >= 0.35, f"Expected >= 35% prompt reduction, got {reduction_pct:.1%} (len={current_len})"


def test_structured_prompt_contains_all_14_sections():
    """P6-02: Verify trimmed prompt strictly preserves all 14 canonical top-level keys."""
    raw_ocr = {"fullText": "Minimal text"}
    msgs = structured_document_prompt(raw_ocr)
    user_content = msgs[1]["content"]

    required_sections = [
        "documentInfo",
        "patientInfo",
        "providerInfo",
        "facilityInfo",
        "diagnosis",
        "symptoms",
        "vitals",
        "labResults",
        "medications",
        "procedures",
        "treatments",
        "treatmentPlan",
        "financialSummary",
        "additionalInformation",
    ]

    for section in required_sections:
        assert f'"{section}"' in user_content, f"Missing section '{section}' in prompt template"


def test_structured_prompt_no_placeholders():
    """Verify prompt does not contain placeholder strings like 'string|null' or 'number|null'."""
    raw_ocr = {"fullText": "Minimal text"}
    msgs = structured_document_prompt(raw_ocr)
    user_content = msgs[1]["content"]

    assert "string|null" not in user_content
    assert "number|null" not in user_content
    assert "boolean|null" not in user_content


def test_extraction_service_num_predict_defaults_to_1024():
    """P6-03: Verify ExtractionService defaults to num_predict=1024 and bounds generation."""
    mock_llm = MagicMock(spec=LLMService)
    mock_llm.chat = AsyncMock(return_value='{"documentInfo": {"documentType": "PRESCRIPTION"}}')

    service = ExtractionService(
        llm=mock_llm,
        vision_model="qwen3-vl:latest",
        chat_model="qwen3-vl:latest",
    )

    assert service.num_predict == 1024


@pytest.mark.asyncio
async def test_extraction_service_bounds_num_predict_in_call():
    """Verify normalize_structured_ocr passes num_predict=1024 even if higher value is requested."""
    mock_llm = MagicMock(spec=LLMService)
    mock_llm.chat = AsyncMock(return_value='{"documentInfo": {"documentType": "PRESCRIPTION"}}')

    # Instantiated with excessive 4096 tokens
    service = ExtractionService(
        llm=mock_llm,
        vision_model="qwen3-vl:latest",
        chat_model="qwen3-vl:latest",
        num_predict=4096,
    )

    await service.normalize_structured_ocr({"fullText": "Sample text"})

    mock_llm.chat.assert_called_once()
    _, kwargs = mock_llm.chat.call_args
    assert kwargs.get("num_predict") == 1024


@pytest.mark.asyncio
async def test_ai_client_ollama_payload_includes_keep_alive():
    """P6-04: Verify Ollama requests include 'keep_alive': '10m' for persistent residency."""
    config = AiClientConfig(
        api_key="",
        base_url="http://192.168.21.176:11434",
        model="qwen3-vl:latest",
        timeout_seconds=30.0,
        max_retries=1,
        max_output_tokens=1024,
        keep_alive="10m",
    )
    client = ChatCompletionsClient(config)

    captured_payloads = []

    async def mock_post_chat(payload):
        captured_payloads.append(payload)
        return {
            "choices": [{"message": {"content": "ok"}, "finish_reason": "stop"}],
            "usage": {"total_tokens": 10},
        }

    with patch.object(client, "_post_chat", side_effect=mock_post_chat):
        await client.generate_text(
            messages=[{"role": "user", "content": "hello"}],
            max_tokens=1024,
        )

    assert len(captured_payloads) == 1
    assert captured_payloads[0].get("keep_alive") == "10m"
    assert captured_payloads[0].get("max_tokens") == 1024


@pytest.mark.asyncio
async def test_ai_client_ollama_vision_payload_includes_keep_alive():
    """Verify Ollama vision requests include 'keep_alive': '10m' in native /api/chat payload."""
    config = AiClientConfig(
        api_key="",
        base_url="http://192.168.21.176:11434",
        model="qwen3-vl:latest",
        timeout_seconds=30.0,
        max_retries=1,
        max_output_tokens=1024,
        keep_alive="10m",
    )
    client = ChatCompletionsClient(config)

    captured_vision_payloads = []

    async def mock_post_ollama_vision(payload, mime_type, image_size):
        captured_vision_payloads.append(payload)
        return {
            "message": {"content": "vision ok"},
            "done_reason": "stop",
        }

    with patch.object(client, "_post_ollama_vision_chat", side_effect=mock_post_ollama_vision):
        await client.generate_json_from_bytes(
            data=b"fake-image-bytes",
            mime_type="image/jpeg",
            prompt="Transcribe text",
        )

    assert len(captured_vision_payloads) == 1
    assert captured_vision_payloads[0].get("keep_alive") == "10m"


@pytest.mark.asyncio
async def test_end_to_end_extraction_with_trimmed_prompt():
    """Verify normalize_structured_ocr parses and normalizes complete 14-section schema with trimmed prompt."""
    mock_llm = MagicMock(spec=LLMService)
    canonical_response = {
        "documentInfo": {"documentType": "PRESCRIPTION", "language": "en"},
        "patientInfo": {"fullName": "Ramesh Patel", "age": 52, "gender": "MALE"},
        "providerInfo": {
            "primary": {"name": "Dr. Dhaval Shah", "specialty": "Cardiology"},
            "providers": [],
        },
        "facilityInfo": {"name": "Shreeji Clinic", "address": "Ahmedabad"},
        "diagnosis": [{"condition": "Hypertension"}],
        "symptoms": [{"description": "Headache"}],
        "vitals": [{"type": "BP", "value": "130/85"}],
        "labResults": [{"testName": "Fasting Sugar", "value": "110", "unit": "mg/dL"}],
        "medications": [{"name": "Telmisartan", "dosage": "40mg", "frequency": "1-0-0"}],
        "procedures": [],
        "treatments": [],
        "treatmentPlan": [],
        "financialSummary": {"currency": "INR", "estimatedTotal": 500},
        "additionalInformation": {"followUpDate": "2026-10-15"},
    }
    mock_llm.chat = AsyncMock(return_value=json.dumps(canonical_response))

    service = ExtractionService(
        llm=mock_llm,
        vision_model="qwen3-vl:latest",
        chat_model="qwen3-vl:latest",
    )

    result = await service.normalize_structured_ocr({
        "fullText": "Shreeji Clinic\nDr. Dhaval Shah\nPatient: Ramesh Patel, 52/M\nRx: Telmisartan 40mg"
    })

    assert result["documentInfo"]["documentType"] == "PRESCRIPTION"
    assert result["patientInfo"]["fullName"] == "Ramesh Patel"
    assert len(result["medications"]) == 1
    assert result["medications"][0]["name"] == "Telmisartan"
    assert "additionalInformation" in result
    assert "financialSummary" in result
