from __future__ import annotations

import asyncio
from pathlib import Path
import time
import pytest

from app.modules.ocr.cache import (
    OcrResultCache,
    compute_ocr_cache_key,
)
from app.modules.ocr.paddle_engine import PaddleOcrEngine
from app.services.pipeline.ocr_stage import OcrStageHandler


@pytest.fixture(scope="module")
def sample_image_bytes() -> bytes:
    p = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "Media (1).jpg"
    assert p.is_file(), f"Fixture not found at {p}"
    return p.read_bytes()


@pytest.fixture(scope="module")
def paddle_engine() -> PaddleOcrEngine:
    engine = PaddleOcrEngine.get_instance(lang="en")
    assert engine.is_available(), f"PaddleOcrEngine failed to initialize: {engine._init_error}"
    return engine


def test_cache_key_generation_deterministic():
    """Verify identical inputs yield identical SHA-256 keys of 64 hex characters."""
    img = b"fake-image-bytes-123"
    key1 = compute_ocr_cache_key(img, pipeline_version="v1.0", engine_config_hash="abc")
    key2 = compute_ocr_cache_key(img, pipeline_version="v1.0", engine_config_hash="abc")

    assert len(key1) == 64
    assert key1 == key2
    assert isinstance(key1, str)


def test_cache_key_distinctness():
    """Verify varying bytes, versions, or config hashes produce distinct keys."""
    base = compute_ocr_cache_key(b"image1", "v1.0", "cfg1")
    diff_bytes = compute_ocr_cache_key(b"image2", "v1.0", "cfg1")
    diff_ver = compute_ocr_cache_key(b"image1", "v2.0", "cfg1")
    diff_cfg = compute_ocr_cache_key(b"image1", "v1.0", "cfg2")

    assert base != diff_bytes
    assert base != diff_ver
    assert base != diff_cfg


def test_cache_invalidation_on_version_or_config_change():
    """Verify cache entries are invalidated when pipeline version or engine config changes."""
    cache = OcrResultCache(max_entries=10, pipeline_version="v1.0")
    dummy_img = b"prescription-image-sample"
    dummy_result = {
        "status": "SUCCESS",
        "text": "Medical Report",
        "confidence": 0.98,
        "lines": [{"text": "Medical Report", "confidence": 0.98}],
    }

    cache.set(dummy_img, dummy_result, engine_config_hash="hash_a")

    # Hit with matching config
    hit = cache.get(dummy_img, engine_config_hash="hash_a")
    assert hit is not None
    assert hit["text"] == "Medical Report"
    assert hit["cached"] is True

    # Miss with different config hash (e.g. model parameters changed)
    miss_cfg = cache.get(dummy_img, engine_config_hash="hash_b")
    assert miss_cfg is None

    # Miss with different pipeline version
    miss_ver = cache.get(dummy_img, engine_config_hash="hash_a", pipeline_version="v2.0")
    assert miss_ver is None


def test_cache_hit_latency_sub_5ms():
    """Verify cache retrieval latency is strictly sub-5ms (P3-02 acceptance criterion)."""
    cache = OcrResultCache(max_entries=10)
    dummy_img = b"heavy-multipage-scan-bytes-mock"
    sample_res = {
        "status": "SUCCESS",
        "text": "Rx: Amoxicillin 500mg\nTake twice daily after meals",
        "confidence": 0.96,
        "lines": [
            {"text": "Rx: Amoxicillin 500mg", "confidence": 0.97},
            {"text": "Take twice daily after meals", "confidence": 0.95},
        ],
    }
    cache.set(dummy_img, sample_res)

    latencies_ms = []
    for _ in range(50):
        t0 = time.perf_counter()
        ret = cache.get(dummy_img)
        dt_ms = (time.perf_counter() - t0) * 1000.0
        latencies_ms.append(dt_ms)
        assert ret is not None
        assert ret["cached"] is True
        assert ret["text"] == sample_res["text"]

    max_lat = max(latencies_ms)
    mean_lat = sum(latencies_ms) / len(latencies_ms)
    assert max_lat < 5.0, f"Max cache latency {max_lat:.3f}ms exceeded 5ms limit!"
    assert mean_lat < 1.0, f"Mean cache latency {mean_lat:.3f}ms higher than expected!"


def test_cache_lru_eviction():
    """Verify cache strictly evicts the least recently accessed item when capacity is reached."""
    cache = OcrResultCache(max_entries=3)

    img_a, res_a = b"img_a", {"status": "SUCCESS", "text": "A"}
    img_b, res_b = b"img_b", {"status": "SUCCESS", "text": "B"}
    img_c, res_c = b"img_c", {"status": "SUCCESS", "text": "C"}
    img_d, res_d = b"img_d", {"status": "SUCCESS", "text": "D"}

    cache.set(img_a, res_a)
    cache.set(img_b, res_b)
    cache.set(img_c, res_c)

    # Access A so B becomes the oldest/least-recently-used
    assert cache.get(img_a) is not None

    # Insert D -> should evict B
    cache.set(img_d, res_d)

    assert cache.get(img_b) is None, "img_b was not evicted!"
    assert cache.get(img_a) is not None, "img_a was unexpectedly evicted!"
    assert cache.get(img_c) is not None, "img_c was unexpectedly evicted!"
    assert cache.get(img_d) is not None, "img_d was missing!"


def test_never_cache_failed_or_partial_results():
    """Verify zero cache poisoning: results with status != 'SUCCESS' must never be cached."""
    cache = OcrResultCache(max_entries=10)

    failed_result = {"status": "FAILED", "text": "", "error": "Engine timeout"}
    fallback_result = {"status": "FALLBACK", "text": "incomplete", "confidence": 0.3}

    cache.set(b"failed_doc", failed_result)
    assert cache.get(b"failed_doc") is None

    cache.set(b"fallback_doc", fallback_result)
    assert cache.get(b"fallback_doc") is None
    assert cache.stats()["entries"] == 0


def test_cache_ttl_expiration():
    """Verify expired cache items are removed and return None."""
    cache = OcrResultCache(max_entries=10, ttl_seconds=0.05)
    cache.set(b"ttl_doc", {"status": "SUCCESS", "text": "TTL Test"})

    # Immediate hit
    assert cache.get(b"ttl_doc") is not None

    # Wait for TTL to expire
    time.sleep(0.06)
    assert cache.get(b"ttl_doc") is None
    assert cache.stats()["entries"] == 0


@pytest.mark.asyncio
async def test_ocr_stage_cache_integration(paddle_engine: PaddleOcrEngine, sample_image_bytes: bytes):
    """Verify OcrStageHandler correctly performs miss on run 1, hit on run 2 with 100% parity."""
    cache = OcrResultCache(max_entries=10)
    handler = OcrStageHandler(
        s3_client=None,  # type: ignore
        paddle_engine=paddle_engine,
        cache=cache,
    )

    # Run 1: Cold execution (miss)
    res_run1 = await handler._extract_page_with_tiered_ocr(sample_image_bytes, page_num=1)
    assert res_run1["status"] == "SUCCESS"
    assert res_run1["cached"] is False
    assert res_run1["engine"] == "paddleocr"
    assert len(res_run1["lines"]) > 0
    assert cache.stats()["hits"] == 0
    assert cache.stats()["misses"] == 1
    assert cache.stats()["entries"] == 1

    # Run 2: Cached execution (hit)
    res_run2 = await handler._extract_page_with_tiered_ocr(sample_image_bytes, page_num=1)
    assert res_run2["status"] == "SUCCESS"
    assert res_run2["cached"] is True
    assert res_run2["elapsed_ms"] < 10
    assert cache.stats()["hits"] == 1
    assert cache.stats()["misses"] == 1

    # Parity assertions: text and lines must be 100% identical
    assert res_run1["text"] == res_run2["text"]
    assert res_run1["confidence"] == res_run2["confidence"]
    assert len(res_run1["lines"]) == len(res_run2["lines"])
    for l1, l2 in zip(res_run1["lines"], res_run2["lines"]):
        assert l1["text"] == l2["text"]
        assert l1["confidence"] == l2["confidence"]
