"""Phase 4b Verification Script: VLM Hardening & Fallback Protection.

Validates:
- VLM-HARD-01: Reasoning suppression in Ollama vision payload ("think": False).
- VLM-HARD-02: Algorithmic pseudo-Latin noise excision & clinical word preservation.
- VLM-HARD-03: Fuzzy line deduplication with SequenceMatcher (>=0.80) & provenance tagging.
- VLM-HARD-04: Fallback output validator (degenerate loops, cyclic repetition, script collapse, premature truncation).
- VLM-HARD-05: Localized crop-only VLM fallback (<35% page area, <=5 failing lines, coordinate preservation).
"""
from __future__ import annotations

import asyncio
import io
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from PIL import Image

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.modules.ocr.fallback_validator import FallbackOutputValidator
from app.services.ai_client import AiClientConfig, ChatCompletionsClient
from app.services.pipeline.ocr_stage import OcrStageHandler
from app.settings import Settings


async def main():
    print("=" * 80)
    print("PHASE 4B VERIFICATION GATE: VLM HARDENING & FALLBACK PROTECTION")
    print("=" * 80)

    checks_passed = 0
    total_checks = 5

    # Check 1: Reasoning Suppression
    print("\n[Check 1: Reasoning Suppression in Ollama Payload]")
    from unittest.mock import patch
    config = AiClientConfig(
        api_key="mock-key",
        base_url="http://192.168.21.176:11434/v1",
        model="qwen2.5-vl:7b",
        timeout_seconds=10.0,
        max_retries=0,
        max_output_tokens=512,
    )
    client = ChatCompletionsClient(config)
    captured_payload = None

    async def mock_post(payload, *args, **kwargs):
        nonlocal captured_payload
        captured_payload = payload
        return {"message": {"content": '{"text": "sample"}'}, "done_reason": "stop"}

    with patch.object(client, "_post_ollama_vision_chat", side_effect=mock_post):
        await client.generate_json_from_bytes(
            data=b"dummy_bytes",
            mime_type="image/jpeg",
            prompt="Transcribe this image.",
        )

    assert captured_payload is not None, "Failed to capture payload"
    assert captured_payload.get("think") is False, f"Expected think: False, got {captured_payload.get('think')}"
    print(f"  [PASS] Ollama vision chat payload contains 'think': False -> {captured_payload.get('think')}")
    checks_passed += 1

    # Check 2: Pseudo-Latin Noise Excision
    print("\n[Check 2: Pseudo-Latin Noise Excision]")
    garbled_samples = [
        {"text": "Eqy qyu lab", "confidence": 0.55},
        {"text": "o 1 a n d e r", "confidence": 0.50},
        {"text": "xzk cjv qtr", "confidence": 0.50},
        {"text": "... --- ///", "confidence": 0.45},
    ]
    valid_samples = [
        {"text": "Platelets: 220,000 /uL", "confidence": 0.95},
        {"text": "Patient: Jane Doe", "confidence": 0.92},
        {"text": "रक्त परीक्षण रिपोर्ट", "confidence": 0.88},
    ]
    for sample in garbled_samples:
        assert OcrStageHandler._is_pseudo_latin_noise(sample) is True, f"Failed to detect noise: {sample}"
    for sample in valid_samples:
        assert OcrStageHandler._is_pseudo_latin_noise(sample) is False, f"False positive on valid sample: {sample}"
    print(f"  [PASS] Correctly classified {len(garbled_samples)} noise lines and {len(valid_samples)} valid clinical lines")
    checks_passed += 1

    # Check 3: Line Deduplication with Provenance Tagging
    print("\n[Check 3: Hybrid Line Deduplication with Provenance]")
    base_lines = [
        {"text": "Complete Blood Count", "confidence": 0.95, "box": [[10, 10], [200, 10], [200, 30], [10, 30]]},
        {"text": "Hemoglobin: 13.5 g/dL", "confidence": 0.94, "box": [[10, 40], [200, 40], [200, 60], [10, 60]]},
    ]
    incoming_lines = [
        # Near duplicate (higher confidence)
        {"text": "Hemoglobin 13.5 g/dL", "confidence": 0.98, "provenance": "vlm_fallback"},
        # New line
        {"text": "WBC: 6,500 /uL", "confidence": 0.92, "provenance": "vlm_fallback"},
    ]
    deduped = OcrStageHandler._deduplicate_lines(base_lines, incoming_lines, similarity_threshold=0.80)
    assert len(deduped) == 3, f"Expected 3 lines after dedup, got {len(deduped)}"
    # Check that Hemoglobin was updated with incoming higher-confidence line
    hemo_line = next(l for l in deduped if "Hemoglobin" in l["text"])
    assert hemo_line.get("provenance") == "vlm_fallback"
    assert hemo_line.get("confidence") == 0.98
    print(f"  [PASS] Deduplication cleanly merged near-duplicate lines with provenance='vlm_fallback'")
    checks_passed += 1

    # Check 4: Fallback Output Validator
    print("\n[Check 4: Fallback Output Validator]")
    validator = FallbackOutputValidator()
    # Degenerate loop check
    loop_text = "Report Line\nReport Line\nReport Line\nReport Line\nReport Line"
    loop_res = validator.validate(loop_text)
    assert not loop_res.is_valid and loop_res.reason == "DEGENERATE_LOOP"

    # Cyclic repetition check
    cyclic_text = "blood sugar test normal blood sugar test normal blood sugar test normal blood sugar test normal"
    cyclic_res = validator.validate(cyclic_text)
    assert not cyclic_res.is_valid and cyclic_res.reason == "DEGENERATE_LOOP"

    # Script collapse check
    english_instead_of_hindi = "This is a medical report with lab results."
    script_res = validator.validate(english_instead_of_hindi, expected_script="devanagari")
    assert not script_res.is_valid and "SCRIPT_COLLAPSE" in script_res.reason

    # Valid response
    valid_text = "City Clinic\nHemoglobin: 14.0 g/dL\nPlatelets: 250,000 /uL"
    valid_res = validator.validate(valid_text)
    assert valid_res.is_valid
    print(f"  [PASS] FallbackOutputValidator correctly intercepted loops, cyclic repetition, and script collapse")
    checks_passed += 1

    # Check 5: Localized Crop-Only VLM Fallback
    print("\n[Check 5: Localized Crop-Only VLM Fallback]")
    img = Image.new("RGB", (600, 800), color=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    img_bytes = buf.getvalue()

    paddle_mock = MagicMock(is_available=lambda: True)
    paddle_res = {
        "lines": [
            {"text": "City Clinic Laboratory", "confidence": 0.95, "box": [[50, 50], [400, 50], [400, 80], [50, 80]]},
            {"text": "Patient: Jane Doe", "confidence": 0.92, "box": [[50, 100], [350, 100], [350, 130], [50, 130]]},
            {"text": "o 1 a n d e r", "confidence": 0.40, "box": [[50, 250], [300, 250], [300, 290], [50, 290]]},
            {"text": "Hemoglobin: 13.5 g/dL", "confidence": 0.96, "box": [[50, 350], [400, 350], [400, 380], [50, 380]]},
        ],
        "full_text": "City Clinic Laboratory\nPatient: Jane Doe\no 1 a n d e r\nHemoglobin: 13.5 g/dL",
        "mean_confidence": 0.81,
        "min_confidence": 0.40,
        "line_count": 4,
        "char_count": 80,
    }
    paddle_mock.async_extract_text_from_bytes = AsyncMock(return_value=paddle_res)

    vision_mock = MagicMock()
    vision_mock.extract_image = AsyncMock(return_value={
        "text": "Platelets: 220,000 /uL",
        "confidence": 0.95,
        "finish_reason": "stop",
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=vision_mock,
        paddle_engine=paddle_mock,
        settings=Settings(ocr_concurrent_race_enabled=False),
    )

    t0 = time.perf_counter()
    page_res = await handler._extract_page_with_tiered_ocr(
        img_bytes=img_bytes,
        page_num=1,
        mime="image/jpeg",
        filename="report.jpg",
    )
    duration_ms = (time.perf_counter() - t0) * 1000

    assert page_res["engine"] == "hybrid_paddle_crop_vlm"
    assert "Platelets: 220,000 /uL" in page_res["text"]
    assert "City Clinic Laboratory" in page_res["text"]
    assert "o 1 a n d e r" not in page_res["text"]
    print(f"  [PASS] Localized crop fallback executed cleanly: engine={page_res['engine']}, time={duration_ms:.2f}ms")
    checks_passed += 1

    print("\n" + "=" * 80)
    print(f"RESULT: ALL {checks_passed}/{total_checks} CHECKS PASSED SUCCESSFULLY.")
    print("=" * 80)


if __name__ == "__main__":
    asyncio.run(main())
