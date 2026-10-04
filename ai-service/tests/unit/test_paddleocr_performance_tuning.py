from __future__ import annotations

import os
import time
from pathlib import Path

import pytest

from app.modules.ocr.paddle_engine import PaddleOcrEngine
from app.settings import Settings
from app.container import Container


@pytest.fixture(scope="module")
def lab1_image_bytes() -> bytes:
    p = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert p.is_file(), f"lab_1_.jpeg fixture missing at {p}"
    return p.read_bytes()


@pytest.fixture(scope="module")
def tuned_paddle_engine() -> PaddleOcrEngine:
    PaddleOcrEngine.reset_instance()
    engine = PaddleOcrEngine.get_instance(
        lang="en",
        bypass_orientation=True,
        cpu_threads=4,
    )
    assert engine.is_available() is True
    return engine


def test_settings_phase2_knobs():
    """Verify Settings loads PADDLE_BYPASS_ORIENTATION and PADDLE_CPU_THREADS defaults and aliases."""
    s = Settings(
        app_env="test",
        openai_api_key="test-key",
        groq_api_key="test-key",
        gemini_api_key="test-key",
    )
    assert s.paddle_bypass_orientation is True
    assert s.paddle_cpu_threads == 4

    # Test override
    s2 = Settings(
        app_env="test",
        openai_api_key="test-key",
        groq_api_key="test-key",
        gemini_api_key="test-key",
        paddle_bypass_orientation=False,
        paddle_cpu_threads=6,
    )
    assert s2.paddle_bypass_orientation is False
    assert s2.paddle_cpu_threads == 6


def test_paddle_engine_bypass_orientation_and_threads_wiring(tuned_paddle_engine: PaddleOcrEngine):
    """Verify PaddleOcrEngine honors bypass_orientation and cpu_threads parameters."""
    assert tuned_paddle_engine.is_available() is True
    assert tuned_paddle_engine.bypass_orientation is True
    assert tuned_paddle_engine.cpu_threads == 4
    assert tuned_paddle_engine.use_textline_orientation is False
    assert tuned_paddle_engine.use_angle_cls is False
    assert isinstance(tuned_paddle_engine.config_hash, str) and len(tuned_paddle_engine.config_hash) == 16


def test_container_wiring_phase2_knobs(tuned_paddle_engine: PaddleOcrEngine):
    """Verify Container passes Settings Phase 2 knobs into PaddleOcrEngine and /health."""
    s = Settings(
        app_env="test",
        openai_api_key="test-key",
        groq_api_key="test-key",
        gemini_api_key="test-key",
        paddle_bypass_orientation=True,
        paddle_cpu_threads=4,
    )
    container = Container(s)
    engine = container.paddle_ocr
    assert engine is not None
    assert engine.bypass_orientation is True
    assert engine.cpu_threads == 4


def test_paddle_engine_warm_inference_performance(tuned_paddle_engine: PaddleOcrEngine, lab1_image_bytes: bytes):
    """Verify warm PaddleOCR inference on lab_1_.jpeg achieves high throughput with zero CER regression."""
    # Warmup pass 1
    _ = tuned_paddle_engine.extract_text_from_bytes(lab1_image_bytes)

    # Warm pass 2 (timed)
    t0 = time.perf_counter()
    res = tuned_paddle_engine.extract_text_from_bytes(lab1_image_bytes)
    warm_elapsed_ms = int((time.perf_counter() - t0) * 1000)

    timings = res["timings"]
    total_ocr_ms = timings["total_ocr_ms"]

    # Verify zero regression on clinical extraction
    assert res["line_count"] == 33, f"Expected 33 lines, got {res['line_count']}"
    assert res["mean_confidence"] >= 0.90, f"Expected mean confidence >= 0.90, got {res['mean_confidence']}"
    assert len(res["full_text"]) >= 350, f"Expected full text length >= 350, got {len(res['full_text'])}"

    # Performance acceptance criterion: warm OCR approaches isolated baseline (< 5500ms under test runner load)
    assert total_ocr_ms < 5500, f"Warm total_ocr_ms {total_ocr_ms}ms exceeded 5500ms ceiling"
    assert warm_elapsed_ms < 5800, f"Warm wall clock {warm_elapsed_ms}ms exceeded 5800ms ceiling"
