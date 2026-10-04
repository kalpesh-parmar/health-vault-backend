import pytest
import asyncio
from pathlib import Path
from uuid import uuid4
from unittest.mock import AsyncMock, MagicMock
from app.modules.vision.vision_service import VisionModelService, VisionModelRequestError
from app.services.pipeline.ocr_stage import OcrStageHandler


class _MockClient:
    engine = "mock-vision"

    async def generate_json_from_bytes(self, *, data: bytes, mime_type: str, prompt: str | None = None) -> tuple[str, str | None]:
        del data, mime_type, prompt
        return '{"pages": [{"page": 1, "text": "Extracted text"}], "type": "LAB_REPORT"}', "STOP"

    async def validate_model_available(self) -> None:
        pass

    async def close(self) -> None:
        pass


def _create_vision_service() -> VisionModelService:
    service = VisionModelService(
        api_key="test-key",
        base_url="http://mock-ai:11434/v1",
        model="mock-vision-model",
        timeout_seconds=5,
        max_retries=0,
        max_output_tokens=256,
        min_text_chars=1,
        cache_size=0,
        max_inline_bytes=1024 * 1024,
    )
    service._client = _MockClient()
    return service


@pytest.mark.asyncio
async def test_extract_image_without_max_pages_contract() -> None:
    """Regression test: calling extract_image without max_pages must succeed without TypeError."""
    service = _create_vision_service()
    res = await service.extract_image(
        b"fake-image-bytes",
        filename="page_1.png",
        mime_type="image/png",
    )
    assert res is not None
    assert res.get("text") == "Extracted text"
    assert res["metrics"]["model"] == "mock-vision-model"


@pytest.mark.asyncio
async def test_extract_image_with_only_positional_bytes() -> None:
    """Regression test: calling extract_image with only image_bytes should apply all defaults."""
    service = _create_vision_service()
    res = await service.extract_image(b"fake-image-bytes")
    assert res is not None
    assert res.get("text") == "Extracted text"


@pytest.mark.asyncio
async def test_extract_image_with_explicit_max_pages() -> None:
    """Regression test: callers passing max_pages=1 or max_pages=0 remain fully compatible."""
    service = _create_vision_service()

    res1 = await service.extract_image(
        b"fake-image-bytes",
        filename="page_1.png",
        mime_type="image/png",
        max_pages=1,
    )
    assert res1.get("text") == "Extracted text"

    res0 = await service.extract_image(
        b"fake-image-bytes",
        filename="page_1.png",
        mime_type="image/png",
        max_pages=0,
    )
    assert res0.get("text") == "Extracted text"


@pytest.mark.asyncio
async def test_extract_image_with_future_kwargs() -> None:
    """Regression test: extract_image accepts forward-compatible arbitrary kwargs."""
    service = _create_vision_service()
    res = await service.extract_image(
        b"fake-image-bytes",
        filename="page_1.png",
        mime_type="image/png",
        max_pages=1,
        dpi=150,
        request_id="req-1234",
    )
    assert res.get("text") == "Extracted text"


@pytest.mark.asyncio
async def test_extract_image_empty_payload_guard() -> None:
    """Ensure empty bytes still raises VisionModelRequestError."""
    service = _create_vision_service()
    with pytest.raises(VisionModelRequestError, match="Empty image payload received"):
        await service.extract_image(b"")


@pytest.mark.asyncio
async def test_extract_image_tiff_unsupported_guard() -> None:
    """Ensure TIFF check remains intact."""
    service = _create_vision_service()
    with pytest.raises(VisionModelRequestError, match="TIFF is not supported"):
        await service.extract_image(b"fake-tiff", mime_type="image/tiff")


@pytest.mark.asyncio
async def test_extract_pdf_defaults() -> None:
    """Regression test: extract_pdf allows omitting max_pages and accepts kwargs."""
    service = _create_vision_service()
    service._ensure_client = MagicMock(return_value=_MockClient())
    service._ensure_client().engine = "google-genai"

    res = await service.extract_pdf(b"%PDF-1.4 test")
    assert res is not None
    assert res.get("text") == "Extracted text"


@pytest.mark.asyncio
async def test_ocr_stage_handler_calls_extract_image_with_contract(tmp_path: Path) -> None:
    """Verify OcrStageHandler invokes extract_image on image input with the correct contract."""
    vision_mock = AsyncMock()
    vision_mock.extract_image = AsyncMock(return_value={"text": "OCR Image Text"})
    s3_mock = MagicMock()

    handler = OcrStageHandler(
        s3_client=s3_mock,
        lifecycle=None,
        vision_service=vision_mock,
    )

    test_file = tmp_path / "test_scan.png"
    # Create minimal 1x1 png image
    test_file.write_bytes(
        b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x06\x00\x00\x00\x1f\x15c4\x00\x00\x00\nIDATx\x9cc\x00\x01\x00\x00\x05\x00\x01\r\n-\xb4\x00\x00\x00\x00IEND\xaeB`\x82"
    )

    result = await handler.run_ocr(
        file_path=test_file,
        filename="test_scan.png",
        job_id=uuid4(),
        file_key="benchmark/test/test_scan.png",
        current_pct=20,
        completed_stages=[],
        checkpoint_data={},
        mime_type="image/png",
    )

    assert result["text"] == "OCR Image Text"
    vision_mock.extract_image.assert_called_once()
    call_kwargs = vision_mock.extract_image.call_args.kwargs
    assert call_kwargs.get("max_pages") == 1
    assert call_kwargs.get("mime_type") == "image/png"


@pytest.mark.asyncio
async def test_extract_image_accepts_dict_with_text_format() -> None:
    """When the VLM outputs a dict with text and confidence, it normalizes into pages."""
    service = _create_vision_service()
    raw_mock = _MockClient()
    raw_mock.generate_json_from_bytes = AsyncMock(
        return_value=('{"text": "Patient: Rajesh Kumar\\nHb: 14.5 g/dL", "confidence": 0.92}', "STOP")
    )
    service._client = raw_mock

    res = await service.extract_image(b"fake-image-bytes", filename="scan.jpg", mime_type="image/jpeg")
    assert res is not None
    assert "Rajesh Kumar" in res["text"]
    assert "Hb: 14.5 g/dL" in res["text"]
    assert res["confidence"] == 0.92


@pytest.mark.asyncio
async def test_extract_image_recovers_markdown_fenced_json() -> None:
    """When the VLM wraps JSON in markdown fences, it parses successfully."""
    service = _create_vision_service()
    fenced_mock = _MockClient()
    fenced_mock.generate_json_from_bytes = AsyncMock(
        return_value=(
            '```json\n{"pages": [{"page": 1, "text": "Fenced JSON Report Content", "confidence": 0.96}]}\n```',
            "STOP",
        )
    )
    service._client = fenced_mock

    res = await service.extract_image(b"fake-image-bytes", filename="scan.jpg", mime_type="image/jpeg")
    assert res is not None
    assert res["text"] == "Fenced JSON Report Content"
    assert res["confidence"] == 0.96

