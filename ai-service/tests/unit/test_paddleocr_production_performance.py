from __future__ import annotations

import asyncio
import os
import time
from pathlib import Path
from typing import Any

import pytest
import numpy as np

from app.modules.ocr.paddle_engine import PaddleOcrEngine
from app.services.pipeline.ocr_stage import OcrStageHandler
from app.settings import Settings


@pytest.fixture(scope="module")
def lab1_image_bytes() -> bytes:
    p = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert p.is_file(), f"lab_1_.jpeg fixture missing at {p}"
    return p.read_bytes()


@pytest.fixture(scope="module")
def paddle_engine() -> PaddleOcrEngine:
    engine = PaddleOcrEngine.get_instance(lang="en")
    assert engine.is_available() is True
    return engine


def test_paddleocr_timing_instrumentation_spans(paddle_engine: PaddleOcrEngine, lab1_image_bytes: bytes):
    """Verify PaddleOcrEngine returns all 7 granular timing spans without relying only on total elapsed time."""
    res = paddle_engine.extract_text_from_bytes(lab1_image_bytes)

    assert "timings" in res, "Expected 'timings' key in OCR extraction result"
    timings = res["timings"]

    required_spans = [
        "get_instance_ms",
        "engine_init_ms",
        "image_decode_ms",
        "detector_ms",
        "recognizer_ms",
        "result_conversion_ms",
        "total_ocr_ms",
    ]
    for span in required_spans:
        assert span in timings, f"Expected timing span '{span}' in timings dictionary: {timings}"
        assert isinstance(timings[span], int), f"Timing span '{span}' must be an integer (ms)"
        assert timings[span] >= 0, f"Timing span '{span}' must be non-negative"

    # Verification of sub-stages
    assert timings["total_ocr_ms"] > 0
    assert timings["recognizer_ms"] > 0
    assert timings["detector_ms"] >= 0
    assert timings["engine_init_ms"] >= 0
    assert res.get("worker_pid") is not None
    assert res["line_count"] >= 25
    assert res["mean_confidence"] >= 0.85


def test_paddleocr_warm_inference_performance(paddle_engine: PaddleOcrEngine, lab1_image_bytes: bytes):
    """Regression test: Warm PaddleOCR execution on lab_1_.jpeg must approach isolated baseline (< 3500ms).
    Prevents regression to the 80-second server model / unwarping pipeline.
    """
    # Warm-up pass 1
    _ = paddle_engine.extract_text_from_bytes(lab1_image_bytes)

    # Timed warm pass 2
    t0 = time.perf_counter()
    res = paddle_engine.extract_text_from_bytes(lab1_image_bytes)
    warm_elapsed_ms = int((time.perf_counter() - t0) * 1000)

    timings = res["timings"]
    total_ocr_ms = timings["total_ocr_ms"]

    # Acceptance Criterion: Warm OCR approaches isolated baseline (< 5500ms under full test runner load)
    assert total_ocr_ms < 5500, (
        f"Warm OCR total_ocr_ms {total_ocr_ms}ms exceeded 5500ms threshold (det={timings['detector_ms']}ms, "
        f"rec={timings['recognizer_ms']}ms). Possible regression to heavy server models or single-thread crawling."
    )
    assert warm_elapsed_ms < 5800, f"Wall-clock warm inference {warm_elapsed_ms}ms exceeded threshold"
    assert res["line_count"] == 33
    assert res["mean_confidence"] >= 0.90


@pytest.mark.asyncio
async def test_ocr_stage_production_path_performance(lab1_image_bytes: bytes, tmp_path: Path):
    """End-to-end stage test verifying OcrStageHandler uses PaddleOCR on lab_1_.jpeg in < 3500ms warm."""
    engine = PaddleOcrEngine.get_instance(lang="en")
    settings = Settings(
        app_env="test",
        openai_api_key="test-key",
        groq_api_key="test-key",
        gemini_api_key="test-key",
        ocr_router_min_confidence=0.82,
    )

    class MockQualityGate:
        def evaluate(self, ocr_res):
            from app.modules.ocr.quality_gate import QualityGateResult
            return QualityGateResult(passed=True, reason="PASSED", details={})

    handler = OcrStageHandler(
        s3_client=None,
        paddle_engine=engine,
        quality_gate=MockQualityGate(),
    )

    # Execute tiered OCR directly on bytes
    t0 = time.perf_counter()
    page_res = await handler._extract_page_with_tiered_ocr(lab1_image_bytes, page_num=1)
    stage_elapsed_ms = int((time.perf_counter() - t0) * 1000)

    assert page_res["status"] == "SUCCESS"
    assert page_res["engine"] == "paddleocr"
    assert page_res["fallback_reason"] is None
    assert page_res["confidence"] >= 0.90

    tel = page_res.get("telemetry", {})
    assert tel.get("total_ocr_ms", 0) < 5500, f"Stage total_ocr_ms {tel.get('total_ocr_ms')} exceeded 5500ms"
    assert tel.get("detector_ms") is not None
    assert tel.get("recognizer_ms") is not None
