"""Phase 5 VLM Fallback Tuning & Payload Optimization Verification Script.

Executes Task 6 end-to-end verification gate for:
- VLM-01: Proportional downscaling for images > 1500px, payload reduction >= 40%
- VLM-02: Explicit context window configuration (VLM_NUM_CTX: 4096)
- VLM-03: Token generation clamping (VLM_NUM_PREDICT: 1536)
- VLM-04: Streamline OCR fallback prompt to plain text/markdown transcription
"""
from __future__ import annotations

import asyncio
import io
import json
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock
from PIL import Image, ImageDraw

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from app.settings import get_settings
from app.modules.vision.vision_service import VisionModelService, downscale_image_if_needed, _OCR_PROMPT, _page_prompt
from app.services.ai_client import AiClientConfig, ChatCompletionsClient
from app.services.pipeline.ocr_stage import OcrStageHandler


def _create_synthetic_image(width: int, height: int) -> bytes:
    img = Image.new("RGB", (width, height), color=(245, 245, 250))
    draw = ImageDraw.Draw(img)
    for y in range(0, height, 50):
        draw.line([(0, y), (width, y)], fill=(210, 210, 210), width=1)
    for x in range(0, width, 50):
        draw.line([(x, 0), (x, height)], fill=(210, 210, 210), width=1)
    draw.rectangle([100, 100, min(width - 100, 600), min(height - 100, 400)], fill=(65, 105, 225))
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=92)
    return buf.getvalue()


async def verify_phase5():
    print("=" * 80)
    print("PHASE 5 VERIFICATION GATE: VLM FALLBACK TUNING & PAYLOAD OPTIMIZATION")
    print("=" * 80)

    results = {}

    # ──────────────────────────────────────────────────────────────────────────
    # Check 1: VLM-01 Image Downscaling & Payload Compression Gate
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 1: Proportional Image Downscaling & Payload Reduction (VLM-01)]")
    # 1a. Large image exceeding 1500px
    large_bytes = _create_synthetic_image(3000, 2000)
    scaled_bytes, info = downscale_image_if_needed(large_bytes, max_side=1500)

    print(f"  - Original dimensions: {info['original_dims']}")
    print(f"  - Scaled dimensions:   {info['scaled_dims']}")
    print(f"  - Original size:       {len(large_bytes):,} bytes")
    print(f"  - Scaled size:         {len(scaled_bytes):,} bytes")
    print(f"  - Bytes saved:         {info['bytes_saved_pct']:.2f}%")
    print(f"  - Downscaled flag:     {info['downscaled']}")

    assert info["downscaled"] is True, "Image should have been marked downscaled"
    assert info["scaled_dims"] == (1500, 1000), f"Expected (1500, 1000), got {info['scaled_dims']}"
    assert info["bytes_saved_pct"] >= 40.0, f"Expected >= 40% reduction, got {info['bytes_saved_pct']}%"
    with Image.open(io.BytesIO(scaled_bytes)) as result_img:
        assert result_img.size == (1500, 1000), f"Image file size mismatch: {result_img.size}"

    # 1b. Standard image within 1500px limit
    normal_bytes = _create_synthetic_image(1200, 800)
    normal_scaled, normal_info = downscale_image_if_needed(normal_bytes, max_side=1500)
    print(f"  - Sub-1500px image:    {normal_info['original_dims']} -> downscaled={normal_info['downscaled']}, untouched={normal_scaled == normal_bytes}")

    assert normal_info["downscaled"] is False
    assert normal_scaled == normal_bytes
    assert normal_info["bytes_saved_pct"] == 0.0

    results["check_1_downscaling"] = "PASS"

    # ──────────────────────────────────────────────────────────────────────────
    # Check 2: VLM-02 & VLM-03 Settings & Client Options Configuration
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 2: Options Configuration (VLM-02 num_ctx & VLM-03 num_predict)]")
    settings = get_settings()
    print(f"  - settings.vlm_max_image_side: {settings.vlm_max_image_side} (expected 1500)")
    print(f"  - settings.vlm_num_ctx:        {settings.vlm_num_ctx} (expected 4096)")
    print(f"  - settings.vlm_num_predict:    {settings.vlm_num_predict} (expected 1536)")

    assert settings.vlm_max_image_side == 1500
    assert settings.vlm_num_ctx == 4096
    assert settings.vlm_num_predict == 1536

    # Test options injection into HTTP payload
    config = AiClientConfig(
        api_key="",
        base_url="http://mock-ai:11434/v1",
        model="qwen2.5-vl:7b",
        timeout_seconds=5,
        max_retries=0,
        max_output_tokens=1536,
        num_ctx=settings.vlm_num_ctx,
        num_predict=settings.vlm_num_predict,
    )
    client = ChatCompletionsClient(config)
    captured_payload = None

    class MockResponse:
        status_code = 200
        text = '{"message": {"content": "Transcribed plain text"}}'
        content = b'{"message": {"content": "Transcribed plain text"}}'

        def json(self):
            return {
                "message": {"content": "Transcribed plain text"},
                "done_reason": "stop",
                "total_duration": 50000000,
                "eval_count": 25,
                "eval_duration": 50000000,
            }

    async def mock_post(url, json=None, headers=None):
        nonlocal captured_payload
        captured_payload = json
        return MockResponse()

    mock_http = AsyncMock()
    mock_http.post = mock_post
    client._client = mock_http
    client._ensure_http_client = lambda: mock_http

    resp_text, finish = await client.generate_json_from_bytes(
        data=b"test-bytes",
        mime_type="image/jpeg",
        prompt="OCR prompt",
        json_only=False,
    )

    print(f"  - Captured payload options:    {captured_payload.get('options')}")
    assert "options" in captured_payload
    assert captured_payload["options"]["num_ctx"] == 4096
    assert captured_payload["options"]["num_predict"] == 1536
    assert "format" not in captured_payload, "format: json should NOT be present when json_only=False"
    results["check_2_options_propagation"] = "PASS"

    # ──────────────────────────────────────────────────────────────────────────
    # Check 3: VLM-04 OCR Prompt Streamlining & Plain Text Recovery
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 3: OCR Prompt Streamlining & Plain Text Recovery (VLM-04)]")
    print(f"  - _OCR_PROMPT preview:         {_OCR_PROMPT[:80]}...")
    print(f"  - _page_prompt(1) preview:     {_page_prompt(1)[:80]}...")

    assert "clean markdown/plain text" in _OCR_PROMPT
    assert "ONLY valid JSON in this shape" not in _OCR_PROMPT
    assert "clean markdown/plain text" in _page_prompt(1)
    assert "ONLY valid JSON in this shape" not in _page_prompt(1)

    # Test plain text markdown parsing in VisionModelService
    service = VisionModelService(
        api_key="test-key",
        base_url="http://mock-ai:11434/v1",
        model="qwen2.5-vl:7b",
        timeout_seconds=5,
        max_retries=0,
        max_output_tokens=1536,
        min_text_chars=1,
        cache_size=0,
        max_inline_bytes=10 * 1024 * 1024,
    )

    plain_markdown_response = (
        "## Diagnostic Laboratory Report\n"
        "| Investigation | Result | Reference Interval |\n"
        "| Hemoglobin | 13.8 g/dL | 13.0 - 17.0 |\n"
        "| Platelet Count | 280,000 /uL | 150,000 - 450,000 |\n"
        "\nFollow up after 30 days."
    )

    class _MockVisionClient:
        engine = "chat-completions"
        def __init__(self, text):
            self.text = text
            self.last_json_only = None

        async def generate_json_from_bytes(self, *, data, mime_type, prompt=None, json_only=True):
            self.last_json_only = json_only
            return self.text, "stop"

        async def validate_model_available(self): pass
        async def close(self): pass

    mock_vision = _MockVisionClient(plain_markdown_response)
    service._client = mock_vision

    parsed_result = await service.extract_image(normal_bytes, mime_type="image/jpeg")
    print(f"  - Extracted text characters:   {len(parsed_result['text'])}")
    print(f"  - Client json_only called:     {mock_vision.last_json_only}")
    print(f"  - Non-empty pages:             {parsed_result['metrics']['non_empty_pages']}")

    assert mock_vision.last_json_only is False
    assert "Diagnostic Laboratory Report" in parsed_result["text"]
    assert "Hemoglobin" in parsed_result["text"]
    assert parsed_result["metrics"]["non_empty_pages"] == 1
    results["check_3_prompt_streamlining"] = "PASS"

    # ──────────────────────────────────────────────────────────────────────────
    # Check 4: End-to-End Downscale Telemetry in extract_image
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 4: End-to-End Downscaling Telemetry Metrics]")
    large_parsed_result = await service.extract_image(large_bytes, mime_type="image/jpeg")
    metrics = large_parsed_result["metrics"]

    print(f"  - vlm_downscaled:              {metrics.get('vlm_downscaled')}")
    print(f"  - vlm_original_dims:           {metrics.get('vlm_original_dims')}")
    print(f"  - vlm_scaled_dims:             {metrics.get('vlm_scaled_dims')}")
    print(f"  - vlm_bytes_saved_pct:         {metrics.get('vlm_bytes_saved_pct')}%")

    assert metrics.get("vlm_downscaled") is True
    assert metrics.get("vlm_original_dims") == (3000, 2000)
    assert metrics.get("vlm_scaled_dims") == (1500, 1000)
    assert metrics.get("vlm_bytes_saved_pct") >= 40.0
    results["check_4_downscale_telemetry"] = "PASS"

    # ──────────────────────────────────────────────────────────────────────────
    # Summary
    # ──────────────────────────────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("PHASE 5 VERIFICATION RESULTS:")
    all_passed = True
    for test_name, status in results.items():
        print(f"  - {test_name:<35}: {status}")
        if status != "PASS":
            all_passed = False
    print("=" * 80)

    if all_passed:
        print("\n>>> ALL PHASE 5 VERIFICATION CHECKS PASSED SUCCESSFULLY! <<<\n")
        return 0
    else:
        print("\n>>> PHASE 5 VERIFICATION CHECKS FAILED! <<<\n")
        return 1


if __name__ == "__main__":
    exit_code = asyncio.run(verify_phase5())
    sys.exit(exit_code)
