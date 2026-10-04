from __future__ import annotations

import asyncio
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path
import pytest
import cv2
import numpy as np

from app.modules.ocr.paddle_engine import PaddleOcrEngine
import app.modules.vision.vision_service as vision_mod


@pytest.fixture(scope="module")
def lab1_image_bytes() -> bytes:
    p = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert p.is_file(), f"Fixture not found at {p}"
    return p.read_bytes()


@pytest.fixture(scope="module")
def paddle_engine() -> PaddleOcrEngine:
    engine = PaddleOcrEngine.get_instance(lang="en")
    assert engine.is_available(), f"PaddleOcrEngine failed to initialize: {engine._init_error}"
    return engine


def test_process_pool_executor_active(paddle_engine: PaddleOcrEngine):
    """Verify engine initializes and uses ProcessPoolExecutor."""
    executor = paddle_engine._get_active_executor()
    assert isinstance(executor, ProcessPoolExecutor), f"Expected ProcessPoolExecutor, got {type(executor)}"
    assert paddle_engine.max_workers >= 1
    assert isinstance(paddle_engine.enable_mkldnn, bool)


def test_global_ocr_removed_from_vision_service():
    """Verify dead global_ocr instance is eliminated from vision_service."""
    assert not hasattr(vision_mod, "global_ocr"), "vision_service still has global_ocr defined!"


@pytest.mark.asyncio
async def test_concurrent_image_extraction(paddle_engine: PaddleOcrEngine, lab1_image_bytes: bytes):
    """Verify 4 simultaneous OCR extractions execute concurrently without deadlocks."""
    tasks = [
        paddle_engine.async_extract_text_from_bytes(lab1_image_bytes),
        paddle_engine.async_extract_text_from_bytes(lab1_image_bytes),
        paddle_engine.async_extract_text_from_bytes(lab1_image_bytes),
        paddle_engine.async_extract_text_from_bytes(lab1_image_bytes),
    ]
    results = await asyncio.gather(*tasks)

    assert len(results) == 4
    for res in results:
        assert res["line_count"] == 33
        assert res["mean_confidence"] >= 0.94
        assert res["char_count"] > 300
        assert "Paracetamol" in res["full_text"] or "Tablet" in res["full_text"] or len(res["lines"]) == 33


def test_synchronous_bytes_and_array_parity(paddle_engine: PaddleOcrEngine, lab1_image_bytes: bytes):
    """Verify extract_text_from_bytes and extract_text_from_image return identical results."""
    res_bytes = paddle_engine.extract_text_from_bytes(lab1_image_bytes)
    nparr = np.frombuffer(lab1_image_bytes, np.uint8)
    img_array = cv2.imdecode(nparr, cv2.IMREAD_COLOR)
    res_array = paddle_engine.extract_text_from_image(img_array)

    assert res_bytes["line_count"] == res_array["line_count"]
    assert res_bytes["full_text"] == res_array["full_text"]
    assert res_bytes["mean_confidence"] == res_array["mean_confidence"]
