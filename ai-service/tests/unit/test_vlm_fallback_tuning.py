import io
import pytest
from PIL import Image, ImageDraw
from unittest.mock import AsyncMock

from app.modules.vision.vision_service import VisionModelService, downscale_image_if_needed
from app.services.ai_client import AiClientConfig, ChatCompletionsClient


def _create_synthetic_image(width: int, height: int, format: str = "JPEG") -> bytes:
    """Helper to generate a synthetic image with varying color blocks and text patterns."""
    img = Image.new("RGB", (width, height), color=(240, 240, 245))
    draw = ImageDraw.Draw(img)
    # Add patterns so compression isn't completely trivial
    for y in range(0, height, 40):
        draw.line([(0, y), (width, y)], fill=(200, 200, 200), width=1)
    for x in range(0, width, 60):
        draw.line([(x, 0), (x, height)], fill=(210, 210, 210), width=1)
    draw.rectangle([50, 50, min(width - 50, 400), min(height - 50, 300)], fill=(70, 130, 180))
    buf = io.BytesIO()
    img.save(buf, format=format, quality=95)
    return buf.getvalue()


class _MockAiClient:
    engine = "chat-completions"

    def __init__(self, response_text: str = "Transcribed medical text"):
        self.response_text = response_text
        self.last_prompt = None
        self.last_json_only = None

    async def generate_json_from_bytes(
        self,
        *,
        data: bytes,
        mime_type: str,
        prompt: str | None = None,
        json_only: bool = True,
    ) -> tuple[str, str | None]:
        del data, mime_type
        self.last_prompt = prompt
        self.last_json_only = json_only
        return self.response_text, "STOP"

    async def validate_model_available(self) -> None:
        pass

    async def close(self) -> None:
        pass


def test_downscale_image_no_op_when_within_limit() -> None:
    """Images with longest side <= max_side must return untouched bytes (VLM-01)."""
    orig_bytes = _create_synthetic_image(1200, 800)
    scaled_bytes, info = downscale_image_if_needed(orig_bytes, max_side=1500)

    assert info["downscaled"] is False
    assert info["original_dims"] == (1200, 800)
    assert info["scaled_dims"] == (1200, 800)
    assert info["bytes_saved_pct"] == 0.0
    assert scaled_bytes == orig_bytes


def test_downscale_image_proportional_reduction_and_payload_saving() -> None:
    """Images exceeding 1500px on longest side must be scaled proportionally and save >= 40% bytes (VLM-01)."""
    orig_bytes = _create_synthetic_image(3000, 2000)
    scaled_bytes, info = downscale_image_if_needed(orig_bytes, max_side=1500)

    assert info["downscaled"] is True
    assert info["original_dims"] == (3000, 2000)
    assert info["scaled_dims"] == (1500, 1000)
    assert info["bytes_saved_pct"] >= 40.0
    assert len(scaled_bytes) < len(orig_bytes)

    # Verify resultant image dimensions directly
    with Image.open(io.BytesIO(scaled_bytes)) as result_img:
        assert result_img.size == (1500, 1000)


def test_downscale_image_portrait_aspect_ratio() -> None:
    """Portrait images exceeding 1500px height must constrain longest side to 1500 (VLM-01)."""
    orig_bytes = _create_synthetic_image(1000, 2500)
    scaled_bytes, info = downscale_image_if_needed(orig_bytes, max_side=1500)

    assert info["downscaled"] is True
    assert info["original_dims"] == (1000, 2500)
    assert info["scaled_dims"] == (600, 1500)
    with Image.open(io.BytesIO(scaled_bytes)) as result_img:
        assert result_img.size == (600, 1500)


def test_downscale_image_handles_corrupt_or_fake_bytes() -> None:
    """Non-image bytes gracefully fallback without raising errors."""
    fake_bytes = b"non-image-payload-data"
    scaled_bytes, info = downscale_image_if_needed(fake_bytes, max_side=1500)

    assert info["downscaled"] is False
    assert scaled_bytes == fake_bytes
    assert info["bytes_saved_pct"] == 0.0


def test_ai_client_config_propagation() -> None:
    """VisionModelService accepts and forwards num_ctx and num_predict to client config (VLM-02, VLM-03)."""
    service = VisionModelService(
        api_key="test-key",
        base_url="http://mock-ai:11434/v1",
        model="qwen2.5-vl:7b",
        timeout_seconds=10,
        max_retries=1,
        max_output_tokens=1536,
        min_text_chars=1,
        cache_size=0,
        max_inline_bytes=10 * 1024 * 1024,
        max_image_side=1500,
        num_ctx=4096,
        num_predict=1536,
    )
    assert service.max_image_side == 1500
    assert service.num_ctx == 4096
    assert service.num_predict == 1536

    client = service._ensure_client()
    assert client.config.num_ctx == 4096
    assert client.config.num_predict == 1536


@pytest.mark.asyncio
async def test_chat_completions_client_options_payload() -> None:
    """ChatCompletionsClient passes num_ctx and num_predict in options payload (VLM-02, VLM-03)."""
    config = AiClientConfig(
        api_key="test-key",
        base_url="http://mock-ai:11434/v1",
        model="qwen2.5-vl:7b",
        timeout_seconds=5,
        max_retries=0,
        max_output_tokens=1536,
        num_ctx=4096,
        num_predict=1536,
    )
    client = ChatCompletionsClient(config)

    # Mock the internal HTTP client session
    captured_payload = None

    class MockResponse:
        status_code = 200
        text = '{"message": {"content": "Transcribed text"}}'
        content = b'{"message": {"content": "Transcribed text"}}'

        def json(self):
            return {
                "message": {"content": "Transcribed text"},
                "done_reason": "stop",
                "total_duration": 100000000,
                "eval_count": 50,
                "eval_duration": 100000000,
            }

    async def mock_post(url, json=None, headers=None):
        nonlocal captured_payload
        captured_payload = json
        return MockResponse()

    mock_http_client = AsyncMock()
    mock_http_client.post = mock_post
    client._client = mock_http_client
    client._ensure_http_client = lambda: mock_http_client

    text, reason = await client.generate_json_from_bytes(
        data=b"dummy-bytes",
        mime_type="image/jpeg",
        prompt="OCR prompt",
        json_only=False,
    )

    assert text == "Transcribed text"
    assert reason == "stop"
    assert captured_payload is not None
    assert "options" in captured_payload
    assert captured_payload["options"]["num_ctx"] == 4096
    assert captured_payload["options"]["num_predict"] == 1536
    # When json_only=False, format: json should NOT be requested
    assert "format" not in captured_payload


@pytest.mark.asyncio
async def test_vision_service_plain_text_ocr_recovery() -> None:
    """VisionModelService gracefully parses plain text/markdown without requiring JSON envelope (VLM-04)."""
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
    mock_client = _MockAiClient(
        response_text="# Complete Blood Count\n| Test | Result | Units |\n| Hemoglobin | 14.2 | g/dL |\n| Platelets | 250,000 | /uL |"
    )
    service._client = mock_client

    img_bytes = _create_synthetic_image(800, 600)
    result = await service.extract_image(img_bytes, mime_type="image/jpeg")

    assert result is not None
    assert "Hemoglobin" in result["text"]
    assert "14.2" in result["text"]
    assert mock_client.last_json_only is False
    assert result["metrics"]["vlm_downscaled"] is False
    assert result["metrics"]["vlm_bytes_saved_pct"] == 0.0


@pytest.mark.asyncio
async def test_vision_service_downscales_large_image_in_extract_image() -> None:
    """VisionModelService applies downscaling and telemetry in extract_image (VLM-01)."""
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
        max_image_side=1500,
    )
    service._client = _MockAiClient("Patient: Jane Doe\nDiagnosis: Hypertension")

    large_img = _create_synthetic_image(2400, 1800)
    result = await service.extract_image(large_img, mime_type="image/jpeg")

    assert result["metrics"]["vlm_downscaled"] is True
    assert result["metrics"]["vlm_original_dims"] == (2400, 1800)
    assert result["metrics"]["vlm_scaled_dims"] == (1500, 1125)
    assert result["metrics"]["vlm_bytes_saved_pct"] >= 40.0
