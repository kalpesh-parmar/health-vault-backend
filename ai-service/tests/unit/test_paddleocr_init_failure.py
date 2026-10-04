from __future__ import annotations

import os
import unittest.mock as mock
import numpy as np
import pytest

from app.modules.ocr.paddle_engine import PaddleOcrEngine, _init_paddle_worker


def test_paddleocr_init_failure_capture():
    """Verify that when worker initialization fails, _init_error is captured,
    is_available() returns False, and raw OCR execution raises RuntimeError.
    """
    PaddleOcrEngine.reset_instance()

    # Simulate worker pool failure with the exact OneDNN/PIR exception string
    simulated_err = (
        "(Unimplemented) ConvertPirAttribute2RuntimeAttribute not support "
        "[pir::ArrayAttribute<pir::DoubleAttribute>] "
        "(at ..\\paddle\\fluid\\framework\\new_executor\\instruction\\onednn\\onednn_instruction.cc:118)"
    )

    class FailingFuture:
        def result(self, timeout=None):
            raise RuntimeError(simulated_err)

    class FailingExecutor:
        def submit(self, fn, *args, **kwargs):
            return FailingFuture()

        def shutdown(self, wait=True, cancel_futures=False):
            pass

    with mock.patch.object(PaddleOcrEngine, "_get_executor", return_value=FailingExecutor()):
        engine = PaddleOcrEngine(enable_mkldnn=True)

        assert engine.is_available() is False, "Engine must not report available on failure"
        assert engine._init_error is not None, "Engine must preserve _init_error"
        assert "ConvertPirAttribute2RuntimeAttribute" in str(engine._init_error)

        dummy = np.zeros((32, 32, 3), dtype=np.uint8)
        with pytest.raises(RuntimeError) as exc_info:
            engine._run_raw_ocr(dummy)
        assert "ConvertPirAttribute2RuntimeAttribute" in str(exc_info.value)

    PaddleOcrEngine.reset_instance()


def test_paddleocr_clean_init_mkldnn_disabled():
    """Verify that with enable_mkldnn=False, PaddleOcrEngine initializes cleanly
    on CPU, dummy ping passes, and is_available() returns True.
    """
    PaddleOcrEngine.reset_instance()

    engine = PaddleOcrEngine.get_instance(lang="en", enable_mkldnn=False)

    assert engine.is_available() is True, f"PaddleOCR should be available when MKLDNN is disabled: {engine._init_error}"
    assert engine._init_error is None
    assert engine.enable_mkldnn is False
    assert engine.device in ("cpu", "gpu:0", "unknown")

    # Run actual text extraction on a small dummy image
    dummy = np.zeros((64, 64, 3), dtype=np.uint8)
    res = engine.extract_text_from_image(dummy)
    assert isinstance(res, dict)
    assert "full_text" in res
    assert res.get("line_count") == 0

    PaddleOcrEngine.reset_instance()


def test_paddleocr_orientation_parameters_compatibility():
    """Verify that PaddleOCR initializes cleanly when orientation flags are specified,
    without triggering 'use_angle_cls and use_textline_orientation are mutually exclusive'.
    """
    PaddleOcrEngine.reset_instance()

    engine = PaddleOcrEngine(
        lang="en",
        use_angle_cls=True,
        use_textline_orientation=True,
        enable_mkldnn=False,
    )

    assert engine.is_available() is True, f"PaddleOCR worker init failed: {engine._init_error}"
    assert engine._init_error is None

    # Dummy inference ping
    dummy = np.zeros((32, 32, 3), dtype=np.uint8)
    res = engine.extract_text_from_image(dummy)
    assert isinstance(res, dict)

    PaddleOcrEngine.reset_instance()

