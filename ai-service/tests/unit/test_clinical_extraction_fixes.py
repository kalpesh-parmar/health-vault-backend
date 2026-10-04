from __future__ import annotations

import json
from unittest.mock import AsyncMock, MagicMock, patch
import pytest

from app.modules.extraction.prompts import structured_document_prompt
from app.modules.extraction.service import ExtractionService
from app.modules.summary.service import SummaryService, parse_summary
from app.services.ai_client import (
    AiClientConfig,
    ChatCompletionsClient,
    _chat_completion_text_and_finish,
)
from app.services.llm.service import LLMService, _validate_json
from app.services.llm.utils import clean_prompt
from app.services.pipeline.clinical_stage import ClinicalStageHandler


@pytest.mark.asyncio
async def test_llm_service_respects_model_argument():
    mock_client = AsyncMock()
    mock_client.engine = "chat-completions"
    mock_client.generate_text.return_value = ('{"status": "ok"}', "stop")

    service = LLMService(
        api_key="test-key",
        base_url="http://localhost:11434/v1",
        model="default-model",
        timeout_seconds=30.0,
        max_retries=1,
        max_output_tokens=1024,
    )
    service._client = mock_client

    result = await service.chat(model="task-specific-model", messages=[{"role": "user", "content": "hi"}])
    assert result == '{"status": "ok"}'
    mock_client.generate_text.assert_awaited_once()
    _, kwargs = mock_client.generate_text.call_args
    assert kwargs.get("model") == "task-specific-model"


@pytest.mark.asyncio
async def test_chat_completions_client_uses_effective_model():
    client = ChatCompletionsClient(
        AiClientConfig(
            api_key="test-key",
            base_url="http://localhost:11434/v1",
            model="default-config-model",
            timeout_seconds=30.0,
            max_retries=1,
            max_output_tokens=1024,
        )
    )

    recorded_payload = None

    async def fake_post_chat(payload):
        nonlocal recorded_payload
        recorded_payload = payload
        return {
            "choices": [{"message": {"content": '{"ok": true}'}, "finish_reason": "stop"}]
        }

    client._post_chat = fake_post_chat

    await client.generate_text(
        model="override-model:14b",
        messages=[{"role": "user", "content": "hello"}],
    )

    assert recorded_payload is not None
    assert recorded_payload["model"] == "override-model:14b"


def test_reasoning_content_recovery_when_content_empty():
    response_with_reasoning = {
        "choices": [
            {
                "message": {
                    "content": "",
                    "reasoning_content": '{"diagnosis": ["Diabetes"]}',
                },
                "finish_reason": "stop",
            }
        ]
    }
    text, finish = _chat_completion_text_and_finish(response_with_reasoning)
    assert text == '{"diagnosis": ["Diabetes"]}'
    assert finish == "stop"


def test_json_validation_with_markdown_and_whitespace():
    markdown_json = """```json
    {
        "patientInfo": {"name": "Test Patient"},
        "diagnosis": ["Hypertension"]
    }
    ```"""
    # Should not raise exception
    _validate_json(markdown_json)


def test_clean_prompt_does_not_corrupt_json_structure():
    long_lines = [f'  "field_{i}": "value_{i}",' for i in range(100)]
    json_text = "{\n" + "\n".join(long_lines) + "\n}"
    cleaned = clean_prompt(json_text, max_chars=500)
    # Must not contain single mid-word ellipsis character
    assert "…" not in cleaned
    assert "\n...\n" in cleaned or len(cleaned) <= 500


def test_structured_document_prompt_cleans_ocr_watermarks():
    watermark = "CONFIDENTIAL WATERMARK LINE 12345\n"
    clinical_text = "Patient: John Doe, Age: 45. Fasting Blood Sugar: 126 mg/dL (Ref: 70-100 mg/dL).\n"
    raw_ocr = {
        "fullText": (watermark * 50) + clinical_text + (watermark * 50),
        "paragraphs": [{"text": "Sample"}],
    }
    msgs = structured_document_prompt(raw_ocr)
    prompt_content = msgs[1]["content"]
    assert "Fasting Blood Sugar: 126 mg/dL" in prompt_content
    # Clean OCR text should have deduplicated the watermark lines
    assert prompt_content.count("CONFIDENTIAL WATERMARK LINE 12345") <= 1


@pytest.mark.asyncio
async def test_clinical_extraction_fallback_observability():
    mock_extraction = MagicMock(spec=ExtractionService)
    mock_extraction.chat_model = "qwen2.5:14b"
    mock_extraction.normalize_structured_ocr = AsyncMock(side_effect=RuntimeError("Ollama connection reset"))

    handler = ClinicalStageHandler(extraction_service=mock_extraction)
    raw_ocr = {"fullText": "Patient Jane Doe, BP 120/80"}

    with patch("app.services.pipeline.clinical_stage.logger.warning") as mock_warn:
        result = await handler.extract_fields(raw_ocr)
        assert result is not None
        mock_warn.assert_called_once()
        log_msg, *log_args = mock_warn.call_args[0]
        assert "AI field extraction failed, falling back to heuristic" in log_msg
        assert "qwen2.5:14b" in log_args
        assert "RuntimeError" in log_args
        # Sensitive text should not be in the message format arguments
        assert "Jane Doe" not in log_msg


def test_parse_summary_tolerates_key_findings():
    model_output = json.dumps({
        "type": "medical",
        "keyFindings": ["Patient has elevated blood glucose", "HbA1c is 8.5%"],
        "medications": ["Metformin 500mg"],
        "tests": ["HbA1c: 8.5%"],
        "warnings": ["High blood sugar"],
        "follow_up": ["Follow up in 3 months"],
    })
    parsed = parse_summary(model_output, mode="concise", document_type="medical")
    assert "Patient has elevated blood glucose" in parsed["summary"]
    assert "Metformin 500mg" in parsed["medications"]
    assert "HbA1c: 8.5%" in parsed["tests"]


@pytest.mark.asyncio
async def test_summary_service_uses_configured_model():
    mock_llm = AsyncMock(spec=LLMService)
    mock_llm.chat.return_value = json.dumps({
        "summary": ["Clinical summary line 1."],
        "medications": [],
        "tests": [],
        "warnings": [],
        "follow_up": [],
    })

    service = SummaryService(
        mock_llm,
        model="custom-summary-model",
        chunk_chars=3600,
        max_chunks=2,
        num_predict=1024,
    )

    res = await service.summarize("Patient had a normal checkup.")
    assert "Clinical summary line 1." in res["summary"]
    mock_llm.chat.assert_awaited()
    _, kwargs = mock_llm.chat.call_args
    assert kwargs.get("model") == "custom-summary-model"
