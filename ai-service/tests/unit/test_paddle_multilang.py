import pytest
import numpy as np
import cv2
from unittest.mock import MagicMock, AsyncMock, patch

from app.modules.ocr.paddle_engine import (
    PaddleOcrEngine,
    _normalize_lang,
)


def test_normalize_lang():
    assert _normalize_lang("en") == "en"
    assert _normalize_lang("latin") == "en"
    assert _normalize_lang("eng") == "en"
    assert _normalize_lang("english") == "en"
    assert _normalize_lang(None) == "en"
    assert _normalize_lang("") == "en"

    assert _normalize_lang("hi") == "devanagari"
    assert _normalize_lang("mr") == "devanagari"
    assert _normalize_lang("devanagari") == "devanagari"
    assert _normalize_lang("hindi") == "devanagari"
    assert _normalize_lang("marathi") == "devanagari"

    assert _normalize_lang("ta") == "ta"
    assert _normalize_lang("tamil") == "ta"
    assert _normalize_lang("tam") == "ta"


@pytest.mark.asyncio
async def test_async_extract_text_from_bytes_with_lang():
    engine = PaddleOcrEngine.__new__(PaddleOcrEngine)
    engine.lang = "en"
    engine._device = "cpu"
    engine._init_error = None
    engine.last_timings = {}

    # Mock _run_raw_ocr_bytes
    mock_raw = (
        [[
            [[[10, 10], [50, 10], [50, 30], [10, 30]], ("नमस्ते", 0.95)]
        ]],
        120,
        {"worker_pid": 1234, "lang": "devanagari"}
    )
    with patch.object(engine, "_run_raw_ocr_bytes", return_value=mock_raw) as mock_run:
        dummy_bytes = b"fake_bytes"
        res = await engine.async_extract_text_from_bytes(dummy_bytes, lang="hi")

        mock_run.assert_called_once_with(dummy_bytes, lang="devanagari")
        assert res["full_text"] == "नमस्ते"
        assert res["mean_confidence"] == 0.95
        assert res["lang"] == "devanagari"


@pytest.mark.asyncio
async def test_async_extract_text_from_bytes_tamil():
    engine = PaddleOcrEngine.__new__(PaddleOcrEngine)
    engine.lang = "en"
    engine._device = "cpu"
    engine._init_error = None
    engine.last_timings = {}

    mock_raw = (
        [[
            [[[10, 10], [50, 10], [50, 30], [10, 30]], ("வணக்கம்", 0.96)]
        ]],
        150,
        {"worker_pid": 1234, "lang": "ta"}
    )
    with patch.object(engine, "_run_raw_ocr_bytes", return_value=mock_raw) as mock_run:
        dummy_bytes = b"fake_bytes"
        res = await engine.async_extract_text_from_bytes(dummy_bytes, lang="ta")

        mock_run.assert_called_once_with(dummy_bytes, lang="ta")
        assert res["full_text"] == "வணக்கம்"
        assert res["mean_confidence"] == 0.96
        assert res["lang"] == "ta"


def test_empty_result_includes_lang():
    engine = PaddleOcrEngine.__new__(PaddleOcrEngine)
    engine.lang = "en"
    engine._device = "cpu"
    engine._init_error = None

    res_empty = engine._empty_result(lang="devanagari")
    assert res_empty["lines"] == []
    assert res_empty["full_text"] == ""
    assert res_empty["lang"] == "devanagari"
