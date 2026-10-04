from __future__ import annotations

import asyncio
from pathlib import Path
import pickle
import pytest

from app.modules.ocr.paddle_engine import PaddleOcrEngine, _sanitize_for_pickle
from app.services.pipeline.ocr_stage import OcrStageHandler
from app.container import Container
from app.settings import get_settings


@pytest.fixture(scope="module")
def lab1_image_path() -> Path:
    p = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert p.is_file(), f"Fixture not found at {p}"
    return p


@pytest.fixture(scope="module")
def lab1_image_bytes(lab1_image_path: Path) -> bytes:
    return lab1_image_path.read_bytes()


def test_base_result_pickle_serialization():
    """Verify BaseResult and CopyableWeakMethod pickle cleanly without TypeError."""
    try:
        from paddlex.inference.common.result.base_result import BaseResult, CopyableWeakMethod
        r = BaseResult({"text": "test_token", "confidence": 0.99})
        # Serializing BaseResult must not raise 'cannot pickle CopyableWeakMethod object'
        data = pickle.dumps(r)
        unpickled = pickle.loads(data)
        assert unpickled["text"] == "test_token"
    except ImportError:
        pytest.skip("paddlex not installed in this environment")


def test_worker_output_sanitization():
    """Verify _sanitize_for_pickle produces standard Python primitives."""
    try:
        from paddlex.inference.common.result.base_result import BaseResult
        r = BaseResult({"text": "prescription_header", "scores": [0.95, 0.98]})
        sanitized = _sanitize_for_pickle(r)
        assert type(sanitized) is dict
        assert sanitized["text"] == "prescription_header"
        assert not hasattr(sanitized, "_save_funcs")
        data = pickle.dumps(sanitized)
        assert pickle.loads(data) == sanitized
    except ImportError:
        # Fallback test with synthetic dict with private attributes
        sanitized = _sanitize_for_pickle({"_private": "skip", "public": "keep"})
        assert sanitized == {"public": "keep"}


def test_worker_process_paddle_extraction(lab1_image_bytes: bytes):
    """Verify PaddleOCR extracts lab_1_.jpeg across ProcessPoolExecutor without pickling crash."""
    engine = PaddleOcrEngine.get_instance(lang="en")
    assert engine.is_available(), f"PaddleOcrEngine failed to start: {engine._init_error}"
    assert engine._init_error is None

    res = engine.extract_text_from_bytes(lab1_image_bytes)
    assert res is not None
    assert res["line_count"] in (33, 34, 35)
    assert res["mean_confidence"] >= 0.94
    assert res["char_count"] > 300
    assert "URMILA" in res["full_text"] or "Clinic" in res["full_text"] or "MBSON" in res["full_text"]


@pytest.mark.asyncio
async def test_ocr_stage_routing_lab1_uses_paddleocr(lab1_image_path: Path):
    """Regression test: verify production OcrStageHandler runs PaddleOCR on lab_1_.jpeg
    and does NOT route to Qwen3-VL fallback.
    """
    settings = get_settings()
    container = Container(settings)
    handler: OcrStageHandler = container.ocr_stage_handler
    # Decouple lifecycle notifications to prevent hanging on external PostgreSQL connection in unit test
    handler.lifecycle = None
    from unittest.mock import AsyncMock
    async def _mock_vlm(*args, **kwargs):
        await asyncio.sleep(90)
        return {
            "text": "ફરી બતાવવા માટે 30 દિવસ પછી આવવું",
            "fullText": "ફરી બતાવવા માટે 30 દિવસ પછી આવવું",
            "metrics": {"telemetry": {}},
            "pages": [{"page": 1, "text": "ફરી બતાવવા માટે 30 દિવસ પછી આવવું", "confidence": 0.95}],
        }
    handler.vision.extract_image = AsyncMock(side_effect=_mock_vlm)

    import uuid
    res = await handler.run_ocr(
        file_path=lab1_image_path,
        filename="lab_1_.jpeg",
        job_id=uuid.uuid4(),
        file_key="benchmark/lab_1_.jpeg",
        current_pct=0,
        completed_stages=[],
        checkpoint_data={},
    )

    pages = res.get("pages") or []
    assert len(pages) == 1
    p0 = pages[0]

    # Must be processed by PaddleOCR primary engine (or hybrid if multilingual recovery is active)
    assert p0["engine"] in ("paddleocr", "hybrid_paddle_vlm"), f"Expected paddleocr or hybrid, got {p0['engine']}"
    assert p0["status"] in ("SUCCESS", "FALLBACK"), f"Expected SUCCESS or FALLBACK, got {p0['status']}"

    # Verify metrics reflect primary engine success
    metrics = res.get("metrics") or {}
    assert metrics["used_paddle_ocr"] is True
    assert metrics["elapsed_ms"] < 25000, f"Expected OCR < 25s (PaddleOCR, not ~87s Qwen fallback), got {metrics['elapsed_ms']}ms"
