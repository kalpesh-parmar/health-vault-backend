from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
import pytest

from app.modules.ocr.script_detector import (
    UNICODE_SCRIPT_RANGES,
    detect_scripts_in_text,
    get_character_script,
    inspect_ocr_lines_for_non_latin,
)
from app.modules.ocr.quality_gate import QualityGate, QualityGateResult
from app.services.pipeline.ocr_stage import OcrStageHandler
from app.modules.ocr.paddle_engine import PaddleOcrEngine
from app.modules.vision.vision_service import VisionModelService
from app.settings import Settings


@pytest.fixture(scope="module")
def lab1_image_bytes() -> bytes:
    p = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert p.is_file(), f"Fixture not found at {p}"
    return p.read_bytes()


# ─── Task 1 Tests: Script Detector ───────────────────────────────────────────

def test_unicode_codepoint_script_detection():
    """Verify script detection across Latin, Devanagari, Gujarati, Tamil, etc."""
    # Latin text
    res_lat = detect_scripts_in_text("Complete Blood Count (CBC) Report Dr. Patel")
    assert res_lat["dominant_script"] == "latin"
    assert res_lat["has_non_latin"] is False
    assert "latin" in res_lat["detected_scripts"]

    # Devanagari (Hindi) text
    res_dev = detect_scripts_in_text("दवा दिन में दो बार खाना खाने के बाद लें")
    assert res_dev["dominant_script"] == "devanagari"
    assert res_dev["has_non_latin"] is True
    assert "devanagari" in res_dev["detected_scripts"]

    # Gujarati text (as found on lab_1_.jpeg)
    res_guj = detect_scripts_in_text("ફરી બતાવવા માટે 30 દિવસ પછી આવવું")
    assert res_guj["dominant_script"] == "gujarati"
    assert res_guj["has_non_latin"] is True
    assert "gujarati" in res_guj["detected_scripts"]

    # Tamil text
    res_tam = detect_scripts_in_text("மருந்து காலை மாலை உணவுக்குப் பின்")
    assert res_tam["dominant_script"] == "tamil"
    assert res_tam["has_non_latin"] is True
    assert "tamil" in res_tam["detected_scripts"]

    # Mixed Latin and Gujarati
    res_mixed = detect_scripts_in_text("Rx Paracetamol 650mg: ફરી બતાવવા માટે 30 દિવસ પછી આવવું")
    assert res_mixed["has_non_latin"] is True
    assert "gujarati" in res_mixed["detected_scripts"]
    assert "latin" in res_mixed["detected_scripts"]


def test_character_level_script_mapping():
    """Verify individual character script categorization."""
    assert get_character_script("A") == "latin"
    assert get_character_script("z") == "latin"
    assert get_character_script("9") == "digit"
    assert get_character_script(" ") == "whitespace"
    assert get_character_script("\n") == "whitespace"
    assert get_character_script(":") == "symbol"
    # Gujarati 'ક' (U+0A95)
    assert get_character_script("ક") == "gujarati"
    # Devanagari 'क' (U+0915)
    assert get_character_script("क") == "devanagari"
    # Tamil 'க' (U+0B95)
    assert get_character_script("க") == "tamil"


def test_inspect_ocr_lines_detects_explicit_non_latin():
    """Verify inspect_ocr_lines_for_non_latin finds explicit non-Latin glyphs."""
    lines = [
        {"text": "Patient Name: Rajesh Shah", "confidence": 0.98},
        {"text": "ફરી બતાવવા માટે 30 દિવસ પછી આવવું", "confidence": 0.95},
    ]
    info = inspect_ocr_lines_for_non_latin(lines)
    assert info["has_non_latin"] is True
    assert "gujarati" in info["detected_scripts"]
    assert info["has_potential_unread_non_latin"] is True


def test_inspect_ocr_lines_detects_anomalous_unread_indic():
    """Verify anomalous English line fragments indicating unread Indic scripts are flagged."""
    # Line 32 from lab_1_.jpeg English PaddleOCR: '30Eqyu' conf 0.5907
    lines = [
        {"text": "Dr. Dhaval Patel M.D.", "confidence": 0.98},
        {"text": "30Eqyu", "confidence": 0.5907},
    ]
    info = inspect_ocr_lines_for_non_latin(lines)
    assert info["has_potential_unread_non_latin"] is True
    assert len(info["anomalous_lines"]) == 1
    assert info["anomalous_lines"][0]["text"] == "30Eqyu"


# ─── Task 2 Tests: QualityGate Non-Latin Failure Invariant ─────────────────────

def test_quality_gate_fails_on_unread_non_latin_script():
    """Invariant 3: QualityGate must reject with UNREAD_NON_LATIN_SCRIPT when
    potential non-Latin script is detected but 0 non-Latin characters are recognized.
    """
    gate = QualityGate()
    # 32 high confidence English lines + 1 corrupted Indic line
    ocr_result = {
        "full_text": "Patient: Ramesh Kumar\nAge: 45\nDiagnosis: Hypertension\nRx: Amlodipine 5mg\n30Eqyu",
        "mean_confidence": 0.94,
        "min_confidence": 0.59,
        "lines": [
            {"text": "Patient: Ramesh Kumar", "confidence": 0.98},
            {"text": "Age: 45", "confidence": 0.99},
            {"text": "Diagnosis: Hypertension", "confidence": 0.97},
            {"text": "Rx: Amlodipine 5mg", "confidence": 0.95},
            {"text": "30Eqyu", "confidence": 0.5907},
        ],
    }

    res = gate.evaluate(ocr_result)
    assert res.passed is False
    assert res.reason == "UNREAD_NON_LATIN_SCRIPT"
    assert res.has_unread_non_latin is True


def test_quality_gate_passes_when_non_latin_is_recognized():
    """When non-Latin characters are recognized with good confidence, QualityGate passes."""
    gate = QualityGate()
    ocr_result = {
        "full_text": "દર્દીનું નામ: રમેશભાઈ પટેલ\nઉંમર: ૪૫\nફરી બતાવવા માટે 30 દિવસ પછી આવવું",
        "mean_confidence": 0.95,
        "min_confidence": 0.91,
        "lines": [
            {"text": "દર્દીનું નામ: રમેશભાઈ પટેલ", "confidence": 0.96},
            {"text": "ઉંમર: ૪૫", "confidence": 0.97},
            {"text": "ફરી બતાવવા માટે 30 દિવસ પછી આવવું", "confidence": 0.93},
        ],
    }
    res = gate.evaluate(ocr_result)
    assert res.passed is True
    assert res.reason == "Quality gate passed"


def test_quality_gate_pure_english_unaffected():
    """Clean English clinical documents must pass without false UNREAD_NON_LATIN_SCRIPT flags."""
    gate = QualityGate()
    ocr_result = {
        "full_text": (
            "METROPOLIS HEALTHCARE LTD\n"
            "PATIENT NAME: JOHN DOE  AGE: 34 Y / MALE\n"
            "TEST: COMPLETE BLOOD COUNT (CBC)\n"
            "HEMOGLOBIN: 14.2 g/dL (Reference: 13.0 - 17.0)\n"
            "RBC COUNT: 4.8 mill/cumm (Reference: 4.5 - 5.5)\n"
            "WBC COUNT: 6800 /cumm (Reference: 4000 - 11000)\n"
            "PLATELET COUNT: 250000 /cumm (Reference: 150000 - 450000)\n"
        ),
        "mean_confidence": 0.96,
        "min_confidence": 0.91,
        "lines": [
            {"text": "METROPOLIS HEALTHCARE LTD", "confidence": 0.98},
            {"text": "PATIENT NAME: JOHN DOE  AGE: 34 Y / MALE", "confidence": 0.96},
            {"text": "TEST: COMPLETE BLOOD COUNT (CBC)", "confidence": 0.97},
            {"text": "HEMOGLOBIN: 14.2 g/dL (Reference: 13.0 - 17.0)", "confidence": 0.95},
            {"text": "RBC COUNT: 4.8 mill/cumm (Reference: 4.5 - 5.5)", "confidence": 0.96},
            {"text": "WBC COUNT: 6800 /cumm (Reference: 4000 - 11000)", "confidence": 0.94},
            {"text": "PLATELET COUNT: 250000 /cumm (Reference: 150000 - 450000)", "confidence": 0.96},
        ],
    }
    res = gate.evaluate(ocr_result)
    assert res.passed is True
    assert res.has_unread_non_latin is False


# ─── Task 3 Tests: OCR Stage Routing & Fallback Integration ───────────────────

@pytest.mark.asyncio
async def test_ocr_stage_routes_to_vlm_on_non_latin_fallback():
    """Verify OcrStageHandler falls back to VisionModelService when primary OCR
    fails with UNREAD_NON_LATIN_SCRIPT and merges non-Latin lines into hybrid result.
    """
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True
    mock_paddle.config_hash = "test-hash"
    mock_paddle.async_extract_text_from_bytes = AsyncMock(return_value={
        "full_text": "Prescription Note\n30Eqyu",
        "mean_confidence": 0.92,
        "min_confidence": 0.59,
        "lines": [
            {"text": "Prescription Note", "confidence": 0.98},
            {"text": "30Eqyu", "confidence": 0.5907},
        ],
    })

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "Prescription Note\nફરી બતાવવા માટે 30 દિવસ પછી આવવું",
        "confidence": 0.95,
        "lines": [
            {"text": "Prescription Note", "confidence": 0.95},
            {"text": "ફરી બતાવવા માટે 30 દિવસ પછી આવવું", "confidence": 0.95},
        ],
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )
    handler.settings.ocr_concurrent_race_enabled = False

    page_res = await handler._extract_page_with_tiered_ocr(b"dummy-image-bytes", page_num=1)

    assert page_res["status"] == "FALLBACK"
    assert page_res["fallback_reason"] == "UNREAD_NON_LATIN_SCRIPT"
    assert page_res["engine"] == "hybrid_paddle_vlm"
    # Verify Gujarati line was spliced in
    assert any("ફરી બતાવવા માટે 30 દિવસ પછી આવવું" in l["text"] for l in page_res["lines"])
    # Verify clean English line from Paddle was preserved
    assert any("Prescription Note" in l["text"] for l in page_res["lines"])


@pytest.mark.asyncio
async def test_run_ocr_dynamically_populates_detected_languages(tmp_path: Path):
    """Verify run_ocr dynamically populates detectedLanguages from extracted text."""
    test_file = tmp_path / "prescription.jpg"
    test_file.write_bytes(b"dummy-image-bytes")

    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True
    mock_paddle.config_hash = "test-hash"
    mock_paddle.async_extract_text_from_bytes = AsyncMock(return_value={
        "full_text": "Prescription Note\n30Eqyu",
        "mean_confidence": 0.92,
        "min_confidence": 0.59,
        "lines": [
            {"text": "Prescription Note", "confidence": 0.98},
            {"text": "30Eqyu", "confidence": 0.5907},
        ],
    })

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "Prescription Note\nફરી બતાવવા માટે 30 દિવસ પછી આવવું",
        "confidence": 0.95,
        "lines": [],
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    import uuid
    doc_res = await handler.run_ocr(
        file_path=test_file,
        filename="prescription.jpg",
        job_id=uuid.uuid4(),
        file_key="uploads/prescription.jpg",
        current_pct=10,
        completed_stages=[],
        checkpoint_data={},
        mime_type="image/jpeg",
    )

    assert "english" in doc_res["detectedLanguages"]
    assert "gujarati" in doc_res["detectedLanguages"]
    assert doc_res["metrics"]["has_non_latin"] is True
    assert "gujarati" in doc_res["metrics"]["detected_scripts"]


# ─── Task 4 / OUT-04 Golden Acceptance Test ───────────────────────────────────

@pytest.mark.asyncio
async def test_out04_gujarati_footer_retention(lab1_image_bytes: bytes):
    """OUT-04 Golden Acceptance Test:
    Verify that lab_1_.jpeg triggers UNREAD_NON_LATIN_SCRIPT, invokes VLM fallback,
    and extracts the Gujarati footer text into the final transcription.
    """
    settings = Settings()
    import urllib.request
    try:
        req = urllib.request.Request(f"{settings.ai_base_url}/api/tags")
        with urllib.request.urlopen(req, timeout=1.0):
            pass
    except Exception:
        pytest.skip(f"Live Ollama service unreachable at {settings.ai_base_url}")

    vm = VisionModelService(
        api_key=settings.ai_api_key or "",
        base_url=settings.ai_base_url,
        model=settings.ai_model,
        timeout_seconds=settings.ai_timeout_seconds,
        max_retries=settings.ai_max_retries,
        max_output_tokens=settings.ai_max_output_tokens,
        min_text_chars=settings.ai_min_text_chars,
        cache_size=settings.ai_cache_size,
        max_inline_bytes=settings.ai_max_inline_bytes,
        page_concurrency=settings.ai_page_concurrency,
    )
    paddle = PaddleOcrEngine.get_instance(lang="en")
    handler = OcrStageHandler(
        s3_client=None,
        vision_service=vm,
        paddle_engine=paddle,
    )
    handler.settings.ocr_concurrent_race_enabled = False

    page_res = await handler._extract_page_with_tiered_ocr(lab1_image_bytes, page_num=1)

    assert page_res["status"] == "FALLBACK"
    assert page_res["fallback_reason"] == "UNREAD_NON_LATIN_SCRIPT"
    assert page_res["engine"] == "hybrid_paddle_vlm"
    assert len(page_res["lines"]) >= 32

    # Check for Gujarati Unicode block characters (U+0A80 to U+0AFF)
    has_gujarati = any(
        0x0A80 <= ord(c) <= 0x0AFF
        for c in page_res["text"]
    )
    assert has_gujarati, f"Expected Gujarati characters in output, got: {page_res['text'][-200:]}"


# ─── Phase 2a Tests: Pre-OCR Script Detection & Concurrent Race Routing ─────────

@pytest.mark.asyncio
async def test_script_detection_skips_paddle_on_non_latin():
    """Verify that when a text hint with non-Latin script is provided, PaddleOCR is skipped completely."""
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True
    mock_paddle.async_extract_text_from_bytes = AsyncMock()

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "દવા દિવસમાં બે વાર લેવી",
        "confidence": 0.95,
        "lines": [{"text": "દવા દિવસમાં બે વાર લેવી", "confidence": 0.95}],
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    page_res = await handler._extract_page_with_tiered_ocr(
        b"dummy-image-bytes",
        page_num=3,
        text_hint="દવા દિવસમાં બે વાર",
    )

    # Paddle should NOT be called at all
    mock_paddle.async_extract_text_from_bytes.assert_not_called()
    mock_vision.extract_image.assert_called_once()
    assert page_res["engine"] == "qwen_vl"
    assert "UNREAD_NON_LATIN_SCRIPT_PRE_DETECTED_GUJARATI" in str(page_res["fallback_reason"])
    assert "દવા દિવસમાં બે વાર લેવી" in page_res["text"]


@pytest.mark.asyncio
async def test_concurrent_race_cancels_paddle_when_vlm_returns_non_latin():
    """Verify that in concurrent race, when VLM finishes and detects non-Latin text, Paddle is cancelled."""
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True

    # Simulate Paddle being slow (e.g. 90s)
    async def slow_paddle(img_bytes):
        await asyncio.sleep(10.0)
        return {"full_text": "garbage", "mean_confidence": 0.3, "lines": []}

    mock_paddle.async_extract_text_from_bytes = slow_paddle

    # VLM finishes quickly with Indic text
    async def fast_vlm(img_bytes, **kwargs):
        await asyncio.sleep(0.01)
        return {
            "text": "दवा दिन में दो बार खाना खाने के बाद लें",
            "confidence": 0.96,
            "lines": [{"text": "दવા दिन में दो बार", "confidence": 0.96}],
        }

    mock_vision = MagicMock()
    mock_vision.extract_image = fast_vlm

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    t0 = asyncio.get_running_loop().time()
    page_res = await handler._extract_page_with_tiered_ocr(
        b"dummy-image-bytes",
        page_num=3,
    )
    elapsed = asyncio.get_running_loop().time() - t0

    # Race should complete in fraction of a second, canceling slow Paddle
    assert elapsed < 2.0
    assert page_res["engine"] == "qwen_vl"
    assert "UNREAD_NON_LATIN_SCRIPT" in str(page_res["fallback_reason"])
    assert "दो बार" in page_res["text"]


@pytest.mark.asyncio
async def test_concurrent_race_cancels_vlm_when_paddle_returns_clean_english():
    """Verify that in concurrent race, when Paddle finishes fast with clean English, VLM is cancelled."""
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True

    # Fast Paddle with clean English
    async def fast_paddle(img_bytes):
        await asyncio.sleep(0.01)
        return {
            "full_text": "METROPOLIS HEALTHCARE REPORT\nPATIENT: JOHN DOE",
            "mean_confidence": 0.97,
            "min_confidence": 0.94,
            "lines": [
                {"text": "METROPOLIS HEALTHCARE REPORT", "confidence": 0.98},
                {"text": "PATIENT: JOHN DOE", "confidence": 0.96},
            ],
            "timings": {"detector_ms": 10, "recognizer_ms": 20},
        }

    mock_paddle.async_extract_text_from_bytes = fast_paddle

    # Slow VLM
    vlm_called = False
    async def slow_vlm(img_bytes, **kwargs):
        nonlocal vlm_called
        vlm_called = True
        await asyncio.sleep(10.0)
        return {"text": "METROPOLIS", "confidence": 0.9}

    mock_vision = MagicMock()
    mock_vision.extract_image = slow_vlm

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    t0 = asyncio.get_running_loop().time()
    page_res = await handler._extract_page_with_tiered_ocr(
        b"dummy-image-bytes",
        page_num=1,
    )
    elapsed = asyncio.get_running_loop().time() - t0

    assert elapsed < 2.0
    assert page_res["engine"] == "paddleocr"
    assert page_res["status"] == "SUCCESS"
    assert page_res["fallback_reason"] is None
    assert "METROPOLIS HEALTHCARE" in page_res["text"]


@pytest.mark.asyncio
async def test_paddle_timeout_sequential_fallback_to_vlm():
    """Verify that in sequential mode, PaddleOCR exceeding paddle_timeout_seconds falls back to VLM."""
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True

    async def hanging_paddle(img_bytes):
        await asyncio.sleep(10.0)
        return {"full_text": "Never returned"}

    mock_paddle.async_extract_text_from_bytes = hanging_paddle

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "VLM rescued after Paddle timed out",
        "confidence": 0.92,
        "lines": [{"text": "VLM rescued after Paddle timed out", "confidence": 0.92}],
    })

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )
    # Configure 0.1s timeout and disable race to test sequential fallback branch
    handler.settings.paddle_timeout_seconds = 0.1
    handler.settings.ocr_concurrent_race_enabled = False

    t0 = asyncio.get_running_loop().time()
    page_res = await handler._extract_page_with_tiered_ocr(
        b"dummy-image-bytes",
        page_num=2,
    )
    elapsed = asyncio.get_running_loop().time() - t0

    assert elapsed < 1.0
    assert page_res["engine"] == "qwen_vl"
    assert "PADDLE_TIMEOUT" in str(page_res["fallback_reason"])
    assert "VLM rescued" in page_res["text"]


@pytest.mark.asyncio
async def test_paddle_timeout_concurrent_race_fallback_to_vlm():
    """Verify that in concurrent race, PaddleOCR timing out falls back cleanly to VLM."""
    mock_paddle = MagicMock()
    mock_paddle.is_available.return_value = True

    async def hanging_paddle(img_bytes):
        await asyncio.sleep(10.0)
        return {"full_text": "Never returned"}

    mock_paddle.async_extract_text_from_bytes = hanging_paddle

    async def slow_vision(*args, **kwargs):
        await asyncio.sleep(0.15)
        return {
            "text": "VLM rescued during concurrent race",
            "confidence": 0.91,
            "lines": [{"text": "VLM rescued during concurrent race", "confidence": 0.91}],
        }

    mock_vision = MagicMock()
    mock_vision.extract_image = slow_vision

    handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )
    # Set timeout to 0.1s in race
    handler.settings.paddle_timeout_seconds = 0.1
    handler.settings.ocr_concurrent_race_enabled = True

    t0 = asyncio.get_running_loop().time()
    page_res = await handler._extract_page_with_tiered_ocr(
        b"dummy-image-bytes",
        page_num=3,
    )
    elapsed = asyncio.get_running_loop().time() - t0

    assert elapsed < 1.0
    assert page_res["engine"] == "qwen_vl"
    assert "PADDLE_TIMEOUT" in str(page_res["fallback_reason"])
    assert "VLM rescued" in page_res["text"]


