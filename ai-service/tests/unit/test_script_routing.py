import pytest
from unittest.mock import MagicMock, AsyncMock

from app.services.pipeline.ocr_stage import OcrStageHandler
from app.modules.ocr.quality_gate import QualityGate


@pytest.mark.asyncio
async def test_devanagari_hint_routes_to_paddle_devanagari():
    """Verify that a Devanagari text hint routes PaddleOCR to lang='devanagari' without skipping to VLM."""
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True
    mock_paddle.async_extract_text_from_bytes = AsyncMock(return_value={
        "full_text": "रोगी का नाम: रमेश कुमार\nउम्र: ४५",
        "lines": [
            {"text": "रोगी का नाम: रमेश कुमार", "confidence": 0.95, "box": [[0, 0], [100, 0], [100, 20], [0, 20]]},
            {"text": "उम्र: ४५", "confidence": 0.96, "box": [[0, 30], [100, 30], [100, 50], [0, 50]]},
        ],
        "mean_confidence": 0.955,
        "line_count": 2,
        "char_count": 32,
        "timings": {},
        "worker_pid": 111,
    })

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock()

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )
    handler.settings.ocr_concurrent_race_enabled = False

    res = await handler._extract_page_with_tiered_ocr(
        b"fake-bytes",
        page_num=1,
        text_hint="रोगी का नाम: रमेश कुमार",
    )

    mock_paddle.async_extract_text_from_bytes.assert_awaited_once_with(b"fake-bytes", lang="devanagari")
    mock_vision.extract_image.assert_not_called()
    assert res["status"] == "SUCCESS"
    assert res["engine"] == "paddleocr_devanagari"
    assert "रोगी का नाम: रमेश कुमार" in res["text"]


@pytest.mark.asyncio
async def test_tamil_hint_routes_to_paddle_tamil():
    """Verify that a Tamil text hint routes PaddleOCR to lang='ta' without skipping to VLM."""
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True
    mock_paddle.async_extract_text_from_bytes = AsyncMock(return_value={
        "full_text": "மருத்துவர் அறிக்கை\nவயது: 45",
        "lines": [
            {"text": "மருத்துவர் அறிக்கை", "confidence": 0.94, "box": [[0, 0], [100, 0], [100, 20], [0, 20]]},
            {"text": "வயது: 45", "confidence": 0.95, "box": [[0, 30], [100, 30], [100, 50], [0, 50]]},
        ],
        "mean_confidence": 0.945,
        "line_count": 2,
        "char_count": 28,
        "timings": {},
        "worker_pid": 111,
    })

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock()

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )
    handler.settings.ocr_concurrent_race_enabled = False

    res = await handler._extract_page_with_tiered_ocr(
        b"fake-bytes",
        page_num=1,
        text_hint="மருத்துவர் அறிக்கை",
    )

    mock_paddle.async_extract_text_from_bytes.assert_awaited_once_with(b"fake-bytes", lang="ta")
    mock_vision.extract_image.assert_not_called()
    assert res["status"] == "SUCCESS"
    assert res["engine"] == "paddleocr_ta"
    assert "மருத்துவர் அறிக்கை" in res["text"]


@pytest.mark.asyncio
async def test_gujarati_hint_skips_paddle_to_vlm():
    """Verify that an unsupported script (Gujarati) cleanly skips PaddleOCR and routes to VLM."""
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True
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
    assert res["engine"] == "qwen_vl"
    assert "UNREAD_NON_LATIN_SCRIPT_PRE_DETECTED_GUJARATI" in str(res["fallback_reason"])
    assert "દર્દીનું નામ: રમેશભાઈ પટેલ" in res["text"]


@pytest.mark.asyncio
async def test_unhinted_scan_indic_recovery_success():
    """Verify that when an un-hinted page fails QualityGate on English OCR with anomalous lines,
    local Indic recovery with Devanagari succeeds without invoking VLM.
    """
    mock_paddle = MagicMock()
    mock_paddle.lang = "en"
    mock_paddle.is_available.return_value = True

    # First call: English returns pseudo-Latin garble (e.g. 30Eqyu)
    english_res = {
        "full_text": "Patient Report\n30Eqyu\nDx: Normal",
        "lines": [
            {"text": "Patient Report", "confidence": 0.98, "box": [[0, 0], [100, 0], [100, 20], [0, 20]]},
            {"text": "30Eqyu", "confidence": 0.58, "box": [[0, 30], [100, 30], [100, 50], [0, 50]]},
            {"text": "Dx: Normal", "confidence": 0.95, "box": [[0, 60], [100, 60], [100, 80], [0, 80]]},
        ],
        "mean_confidence": 0.836,
        "line_count": 3,
        "char_count": 32,
        "timings": {},
        "worker_pid": 111,
    }

    # Second call (Indic recovery): Devanagari returns clean text
    deva_res = {
        "full_text": "रोगी रिपोर्ट\n३० दिन\nनिदान: सामान्य",
        "lines": [
            {"text": "रोगी रिपोर्ट", "confidence": 0.96, "box": [[0, 0], [100, 0], [100, 20], [0, 20]]},
            {"text": "३० दिन", "confidence": 0.95, "box": [[0, 30], [100, 30], [100, 50], [0, 50]]},
            {"text": "निदान: सामान्य", "confidence": 0.97, "box": [[0, 60], [100, 60], [100, 80], [0, 80]]},
        ],
        "mean_confidence": 0.96,
        "line_count": 3,
        "char_count": 35,
        "timings": {},
        "worker_pid": 111,
    }

    async def mock_extract(img_bytes, lang="en"):
        if lang == "devanagari":
            return deva_res
        return english_res

    mock_paddle.async_extract_text_from_bytes = AsyncMock(side_effect=mock_extract)

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock()

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )
    handler.settings.ocr_concurrent_race_enabled = False

    res = await handler._extract_page_with_tiered_ocr(
        b"fake-bytes",
        page_num=1,
        text_hint=None,
    )

    # Paddle should be called twice (en then devanagari)
    assert mock_paddle.async_extract_text_from_bytes.await_count == 2
    mock_vision.extract_image.assert_not_called()
    assert res["status"] == "SUCCESS"
    assert res["engine"] == "paddleocr_devanagari"
    assert "रोगी रिपोर्ट" in res["text"]
