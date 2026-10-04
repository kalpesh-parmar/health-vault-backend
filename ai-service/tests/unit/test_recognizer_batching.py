import os
import pytest
import numpy as np
from unittest.mock import MagicMock, patch

from app.modules.ocr.paddle_engine import (
    PaddleOcrEngine,
    _worker_execute_recognize_crops,
)
from app.settings import Settings


def test_settings_exposes_paddle_rec_batch_num():
    s = Settings()
    assert hasattr(s, "paddle_rec_batch_num")
    assert s.paddle_rec_batch_num == 16

    with patch.dict(os.environ, {"PADDLE_REC_BATCH_NUM": "32"}):
        s_custom = Settings()
        assert s_custom.paddle_rec_batch_num == 32


def test_paddle_engine_initializes_with_rec_batch_num():
    with patch.object(PaddleOcrEngine, "_init_ocr"):
        engine = PaddleOcrEngine(
            rec_batch_num=24,
            max_workers=1,
        )
        assert engine.rec_batch_num == 24


def test_worker_execute_recognize_crops_with_mock():
    crop1 = np.ones((32, 100, 3), dtype=np.uint8)
    crop2 = np.ones((32, 120, 3), dtype=np.uint8)

    mock_ocr = MagicMock()
    mock_ocr.text_recognizer = MagicMock(return_value=(
        [("Hemoglobin", 0.98), ("13.5 g/dL", 0.95)],
        0.05,
    ))

    with patch("app.modules.ocr.paddle_engine._get_worker_ocr", return_value=mock_ocr):
        results = _worker_execute_recognize_crops([crop1, crop2], lang="en")
        assert len(results) == 2
        assert results[0] == ("Hemoglobin", 0.98)
        assert results[1] == ("13.5 g/dL", 0.95)


def test_worker_execute_recognize_crops_fallback_ocr():
    crop = np.ones((32, 100, 3), dtype=np.uint8)

    mock_ocr = MagicMock()
    # No text_recognizer method on model -> falls back to ocr()
    del mock_ocr.text_recognizer
    mock_ocr.ocr = MagicMock(return_value=[[("Platelets", 0.96)]])

    with patch("app.modules.ocr.paddle_engine._get_worker_ocr", return_value=mock_ocr):
        results = _worker_execute_recognize_crops([crop], lang="en")
        assert len(results) == 1
        assert results[0] == ("Platelets", 0.96)


def test_worker_execute_recognize_crops_empty():
    assert _worker_execute_recognize_crops([]) == []


@pytest.mark.asyncio
async def test_recognize_crops_and_async_recognize_crops():
    with patch.object(PaddleOcrEngine, "_init_ocr"):
        engine = PaddleOcrEngine(max_workers=1)
    crop = np.ones((32, 100, 3), dtype=np.uint8)

    expected = [("Total Leucocyte Count", 0.97)]
    with patch.object(engine, "recognize_crops", return_value=expected):
        sync_res = engine.recognize_crops([crop])
        assert sync_res == expected

        async_res = await engine.async_recognize_crops([crop])
        assert async_res == expected
