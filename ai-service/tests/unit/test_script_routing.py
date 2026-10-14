import pytest
from unittest.mock import MagicMock, AsyncMock

from app.services.pipeline.ocr_stage import OcrStageHandler
from app.modules.ocr.quality_gate import QualityGate


@pytest.mark.asyncio
async def test_devanagari_hint_routes_to_qwen_vl_exclusive():
    """Verify that a Devanagari document routes directly to Qwen3-VL without invoking PaddleOCR."""
    mock_paddle = MagicMock()
    mock_paddle.async_extract_text_from_bytes = AsyncMock()

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "रोगी का नाम: रमेश कुमार\nउम्र: ४५",
        "confidence": 0.95,
        "lines": [{"text": "रोगी का नाम: रमेश कुमार", "confidence": 0.95}],
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    res = await handler._extract_page_with_tiered_ocr(
        b"fake-bytes",
        page_num=1,
        text_hint="रोगी का नाम: रमेश कुमार",
    )

    mock_paddle.async_extract_text_from_bytes.assert_not_called()
    mock_vision.extract_image.assert_awaited_once()
    assert res["status"] == "SUCCESS"
    assert res["engine"] == "qwen_vl"
    assert "रोगी का नाम: रमेश कुमार" in res["text"]


@pytest.mark.asyncio
async def test_tamil_hint_routes_to_qwen_vl_exclusive():
    """Verify that a Tamil document routes directly to Qwen3-VL without invoking PaddleOCR."""
    mock_paddle = MagicMock()
    mock_paddle.async_extract_text_from_bytes = AsyncMock()

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "மருத்துவர் அறிக்கை\nவயது: 45",
        "confidence": 0.94,
        "lines": [{"text": "மருத்துவர் அறிக்கை", "confidence": 0.94}],
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    res = await handler._extract_page_with_tiered_ocr(
        b"fake-bytes",
        page_num=1,
        text_hint="மருத்துவர் அறிக்கை",
    )

    mock_paddle.async_extract_text_from_bytes.assert_not_called()
    mock_vision.extract_image.assert_awaited_once()
    assert res["status"] == "SUCCESS"
    assert res["engine"] == "qwen_vl"
    assert "மருத்துவர் அறிக்கை" in res["text"]


@pytest.mark.asyncio
async def test_gujarati_hint_routes_to_qwen_vl_exclusive():
    """Verify that a Gujarati document routes directly to Qwen3-VL without invoking PaddleOCR."""
    mock_paddle = MagicMock()
    mock_paddle.async_extract_text_from_bytes = AsyncMock()

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "દર્દીનું નામ: રમેશભાઈ પટેલ",
        "confidence": 0.95,
        "lines": [{"text": "દર્દીનું નામ: રમેશભાઈ પટેલ", "confidence": 0.95}],
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    res = await handler._extract_page_with_tiered_ocr(
        b"fake-bytes",
        page_num=1,
        text_hint="દર્દીનું નામ: રમેશભાઈ પટેલ",
    )

    mock_paddle.async_extract_text_from_bytes.assert_not_called()
    mock_vision.extract_image.assert_awaited_once()
    assert res["status"] == "SUCCESS"
    assert res["engine"] == "qwen_vl"
    assert "દર્દીનું નામ: રમેશભાઈ પટેલ" in res["text"]


@pytest.mark.asyncio
async def test_unhinted_scan_routes_to_qwen_vl_exclusive():
    """Verify that an unhinted scan routes directly to Qwen3-VL without invoking PaddleOCR."""
    mock_paddle = MagicMock()
    mock_paddle.async_extract_text_from_bytes = AsyncMock()

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "Clinical Report: Normal",
        "confidence": 0.98,
        "lines": [{"text": "Clinical Report: Normal", "confidence": 0.98}],
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    res = await handler._extract_page_with_tiered_ocr(
        b"fake-bytes",
        page_num=1,
        text_hint=None,
    )

    mock_paddle.async_extract_text_from_bytes.assert_not_called()
    mock_vision.extract_image.assert_awaited_once()
    assert res["status"] == "SUCCESS"
    assert res["engine"] == "qwen_vl"
    assert "Clinical Report: Normal" in res["text"]
