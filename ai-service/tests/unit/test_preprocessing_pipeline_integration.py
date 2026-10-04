from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock
import cv2
import numpy as np
import pytest

from app.settings import Settings
from app.services.pipeline.ocr_stage import OcrStageHandler


def create_tilted_text_image(angle: float = 12.0) -> bytes:
    """Create a white image with dark text lines rotated by a given angle."""
    img = np.full((300, 500, 3), 255, dtype=np.uint8)
    for y in range(80, 240, 30):
        cv2.putText(img, "CLINICAL LABORATORY BLOOD TEST RESULTS", (30, y), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 2)
    center = (250, 150)
    mat = cv2.getRotationMatrix2D(center, angle, 1.0)
    rotated = cv2.warpAffine(img, mat, (500, 300), borderMode=cv2.BORDER_CONSTANT, borderValue=(255, 255, 255))
    success, encoded = cv2.imencode(".png", rotated)
    assert success
    return encoded.tobytes()


@pytest.mark.asyncio
async def test_extract_page_with_tiered_ocr_deskews_when_enabled():
    """Assert _extract_page_with_tiered_ocr applies deskewing when PREPROCESS_DESKEW_ENABLED=True."""
    settings = Settings(
        PREPROCESS_DESKEW_ENABLED=True,
        PREPROCESS_REMOVE_SHADOWS=False,
    )
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True
    mock_paddle.async_extract_text_from_bytes = AsyncMock(return_value={
        "lines": [{"text": "CLINICAL LABORATORY REPORT", "confidence": 0.96}],
        "full_text": "CLINICAL LABORATORY REPORT",
        "mean_confidence": 0.96,
        "timings": {},
    })

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        paddle_engine=mock_paddle,
        settings=settings,
    )

    tilted_bytes = create_tilted_text_image(12.0)
    res = await handler._extract_page_with_tiered_ocr(
        tilted_bytes,
        page_num=1,
    )

    assert res["status"] == "SUCCESS"
    assert "preprocess_applied" in res["telemetry"]
    assert res["telemetry"]["preprocess_applied"] is True
    assert res["stage_timings"]["preprocess_ms"] >= 0.0

    # Verify Paddle was called with the modified/deskewed image bytes
    called_bytes = mock_paddle.async_extract_text_from_bytes.call_args[0][0]
    assert called_bytes != tilted_bytes


@pytest.mark.asyncio
async def test_extract_page_with_tiered_ocr_passes_through_when_disabled():
    """Assert image bytes pass through untouched when preprocessing is disabled."""
    settings = Settings(
        PREPROCESS_DESKEW_ENABLED=False,
        PREPROCESS_REMOVE_SHADOWS=False,
    )
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True
    mock_paddle.async_extract_text_from_bytes = AsyncMock(return_value={
        "lines": [{"text": "TEST REPORT", "confidence": 0.95}],
        "full_text": "TEST REPORT",
        "mean_confidence": 0.95,
        "timings": {},
    })

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        paddle_engine=mock_paddle,
        settings=settings,
    )

    raw_bytes = create_tilted_text_image(0.0)
    res = await handler._extract_page_with_tiered_ocr(
        raw_bytes,
        page_num=1,
    )

    assert res["status"] == "SUCCESS"
    assert res["telemetry"]["preprocess_applied"] is False

    called_bytes = mock_paddle.async_extract_text_from_bytes.call_args[0][0]
    assert called_bytes == raw_bytes


@pytest.mark.asyncio
async def test_preprocessing_telemetry_logs_timing_spans():
    """Assert stage_timings and telemetry accurately log preprocess_ms."""
    settings = Settings(PREPROCESS_DESKEW_ENABLED=True)
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True
    mock_paddle.async_extract_text_from_bytes = AsyncMock(return_value={
        "lines": [{"text": "REPORT", "confidence": 0.95}],
        "full_text": "REPORT",
        "mean_confidence": 0.95,
        "timings": {},
    })

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        paddle_engine=mock_paddle,
        settings=settings,
    )

    tilted_bytes = create_tilted_text_image(15.0)
    res = await handler._extract_page_with_tiered_ocr(
        tilted_bytes,
        page_num=1,
    )

    assert "preprocess_ms" in res["stage_timings"]
    assert res["stage_timings"]["preprocess_ms"] >= 0.0
    assert res["telemetry"]["preprocess_ms"] == res["stage_timings"]["preprocess_ms"]
