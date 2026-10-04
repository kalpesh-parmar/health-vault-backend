import io
import pytest
from PIL import Image
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.pipeline.ocr_stage import OcrStageHandler


def test_extract_bbox_coords():
    # 4-point polygon
    polygon = [[10, 20], [100, 20], [100, 50], [10, 50]]
    coords = OcrStageHandler._extract_bbox_coords(polygon)
    assert coords == (10.0, 20.0, 100.0, 50.0)

    # Flat 4-coord
    flat = [15, 25, 120, 60]
    coords = OcrStageHandler._extract_bbox_coords(flat)
    assert coords == (15.0, 25.0, 120.0, 60.0)

    # Invalid / empty
    assert OcrStageHandler._extract_bbox_coords(None) is None
    assert OcrStageHandler._extract_bbox_coords([]) is None
    assert OcrStageHandler._extract_bbox_coords("invalid") is None


def test_compute_failing_bboxes_union_isolated_lines():
    image_dims = (1000, 1500)
    lines = [
        {"text": "Line 1 Header", "confidence": 0.95, "box": [[50, 50], [400, 50], [400, 80], [50, 80]]},
        {"text": "Line 2 Patient", "confidence": 0.92, "box": [[50, 100], [350, 100], [350, 130], [50, 130]]},
        # Failing localized line
        {"text": "o 1 a n d e r", "confidence": 0.40, "box": [[50, 200], [300, 200], [300, 240], [50, 240]]},
        {"text": "Line 4 Test", "confidence": 0.91, "box": [[50, 300], [400, 300], [400, 330], [50, 330]]},
        {"text": "Line 5 Result", "confidence": 0.93, "box": [[50, 400], [400, 400], [400, 430], [50, 430]]},
    ]

    res = OcrStageHandler._compute_failing_bboxes_union(lines, image_dims)
    assert res is not None
    crop_box, failing_indices = res
    assert failing_indices == [2]
    # Check that margin was added: x0 = 50 - 20 = 30, y0 = 200 - 20 = 180, x1 = 300 + 20 = 320, y1 = 240 + 20 = 260
    assert crop_box == (30, 180, 320, 260)


def test_compute_failing_bboxes_union_rejects_full_page_failure():
    image_dims = (1000, 1500)
    # All lines failing
    lines = [
        {"text": "bad 1", "confidence": 0.30, "box": [[50, 50], [400, 50], [400, 80], [50, 80]]},
        {"text": "bad 2", "confidence": 0.25, "box": [[50, 100], [400, 100], [400, 130], [50, 130]]},
    ]
    assert OcrStageHandler._compute_failing_bboxes_union(lines, image_dims) is None

    # Too many failing lines (> 5 lines)
    many_failing = [
        {"text": f"bad {i}", "confidence": 0.30, "box": [[50, i * 50], [400, i * 50], [400, i * 50 + 30], [50, i * 50 + 30]]}
        for i in range(8)
    ] + [
        {"text": "good 1", "confidence": 0.95, "box": [[50, 500], [400, 500], [400, 530], [50, 530]]},
    ]
    assert OcrStageHandler._compute_failing_bboxes_union(many_failing, image_dims) is None


@pytest.mark.asyncio
async def test_extract_crop_with_vlm():
    # Create synthetic image bytes
    img = Image.new("RGB", (400, 300), color=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    img_bytes = buf.getvalue()

    vision_mock = MagicMock()
    vision_mock.extract_image = AsyncMock(return_value={
        "text": "Transcribed Crop Line 1\nTranscribed Crop Line 2",
        "confidence": 0.96,
        "finish_reason": "stop",
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=vision_mock,
    )

    crop_box = (50, 50, 250, 150)
    lines = await handler._extract_crop_with_vlm(img_bytes, crop_box)

    assert len(lines) == 2
    assert lines[0]["text"] == "Transcribed Crop Line 1"
    assert lines[0]["confidence"] == 0.96
    assert lines[0]["provenance"] == "vlm_fallback"
    assert lines[0]["box"] == [[50, 50], [250, 50], [250, 150], [50, 150]]
    assert vision_mock.extract_image.await_count == 1


@pytest.mark.asyncio
async def test_tiered_ocr_uses_crop_fallback_when_isolated_failure():
    """Verify that isolated failing line triggers crop fallback and marks hybrid_paddle_crop_vlm."""
    img = Image.new("RGB", (600, 800), color=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    img_bytes = buf.getvalue()

    paddle_mock = MagicMock()
    paddle_mock.is_available = MagicMock(return_value=True)

    paddle_res = {
        "lines": [
            {"text": "City Clinic Laboratory", "confidence": 0.95, "box": [[50, 50], [400, 50], [400, 80], [50, 80]]},
            {"text": "Patient: Jane Doe", "confidence": 0.92, "box": [[50, 100], [350, 100], [350, 130], [50, 130]]},
            {"text": "Age: 32 / Female", "confidence": 0.94, "box": [[50, 150], [300, 150], [300, 180], [50, 180]]},
            # Failing line that causes quality gate to reject
            {"text": "o 1 a n d e r", "confidence": 0.40, "box": [[50, 250], [300, 250], [300, 290], [50, 290]]},
            {"text": "Hemoglobin: 13.5 g/dL", "confidence": 0.96, "box": [[50, 350], [400, 350], [400, 380], [50, 380]]},
        ],
        "full_text": "City Clinic Laboratory\nPatient: Jane Doe\nAge: 32 / Female\no 1 a n d e r\nHemoglobin: 13.5 g/dL",
        "mean_confidence": 0.83,
        "min_confidence": 0.40,
        "line_count": 5,
        "char_count": 95,
    }

    paddle_mock.async_extract_text_from_bytes = AsyncMock(return_value=paddle_res)

    vision_mock = MagicMock()
    async def mock_vision_extract(img_bytes, filename="", **kwargs):
        if filename == "crop_slice.jpg":
            return {
                "text": "Platelets: 220,000 /uL",
                "confidence": 0.95,
                "finish_reason": "stop",
            }
        import asyncio
        await asyncio.sleep(0.05)
        return {
            "text": "Full page text",
            "confidence": 0.95,
            "finish_reason": "stop",
        }

    vision_mock.extract_image = AsyncMock(side_effect=mock_vision_extract)

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=vision_mock,
        paddle_engine=paddle_mock,
    )

    page_res = await handler._extract_page_with_tiered_ocr(
        img_bytes=img_bytes,
        page_num=1,
        mime="image/jpeg",
        filename="report.jpg",
    )

    assert page_res["engine"] == "hybrid_paddle_crop_vlm"
    assert "Platelets: 220,000 /uL" in page_res["text"]
    assert "City Clinic Laboratory" in page_res["text"]
    assert "o 1 a n d e r" not in page_res["text"]


@pytest.mark.asyncio
async def test_tiered_ocr_uses_crop_fallback_sequential_mode():
    """Verify crop fallback executes cleanly in sequential mode when concurrent race is disabled."""
    img = Image.new("RGB", (600, 800), color=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    img_bytes = buf.getvalue()

    paddle_mock = MagicMock()
    paddle_mock.is_available = MagicMock(return_value=True)

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

    from app.settings import Settings
    settings = Settings()
    settings.ocr_concurrent_race_enabled = False

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=vision_mock,
        paddle_engine=paddle_mock,
        settings=settings,
    )

    page_res = await handler._extract_page_with_tiered_ocr(
        img_bytes=img_bytes,
        page_num=1,
        mime="image/jpeg",
        filename="report.jpg",
    )

    assert page_res["engine"] == "hybrid_paddle_crop_vlm"
    assert "Platelets: 220,000 /uL" in page_res["text"]
    assert "City Clinic Laboratory" in page_res["text"]
    assert "o 1 a n d e r" not in page_res["text"]
