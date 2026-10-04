from __future__ import annotations

import io
import time
import zipfile
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import fitz
import pytest
from PIL import Image

from app.modules.ocr.quality_gate import QualityGate
from app.services.pipeline.ocr_stage import OcrStageHandler


def _create_sample_pdf(text: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((50, 72), text, fontsize=12)
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def _create_sample_docx(text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        sample_xml = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:r><w:t>{text}</w:t></w:r></w:p>
  </w:body>
</w:document>"""
        zf.writestr("word/document.xml", sample_xml.encode("utf-8"))
    return buf.getvalue()


@pytest.mark.asyncio
async def test_docx_routes_to_office_direct(tmp_path: Path):
    s3_client = MagicMock()
    handler = OcrStageHandler(s3_client=s3_client)

    docx_bytes = _create_sample_docx("Patient: Ramesh Patel\nDiagnosis: Hypertension\nRx: Telmisartan 40mg")
    doc_path = tmp_path / "prescription.docx"
    doc_path.write_bytes(docx_bytes)

    t0 = time.monotonic()
    result = await handler.run_ocr(
        file_path=doc_path,
        filename="prescription.docx",
        job_id=uuid4(),
        file_key="prescription.docx",
        current_pct=15,
        completed_stages=[],
        checkpoint_data={},
    )
    elapsed = time.monotonic() - t0

    assert elapsed < 0.500, f"DOCX fast path took too long: {elapsed}s"
    assert result["metrics"]["used_direct_text"] is True
    assert result["metrics"]["used_ocr"] is False
    assert result["metrics"]["used_paddle_ocr"] is False
    assert result["metrics"]["used_qwen_vl"] is False
    assert result["pages"][0]["engine"] == "office_direct"
    assert result["pages"][0]["status"] == "SUCCESS"
    assert "Telmisartan 40mg" in result["fullText"]


@pytest.mark.asyncio
async def test_scanned_pdf_routes_to_paddle_primary(tmp_path: Path):
    """Scanned PDF page should invoke PaddleOCR and completely bypass Vision model."""
    doc = fitz.open()
    _page = doc.new_page()  # blank page without text -> requires OCR
    pdf_bytes = doc.tobytes()
    doc.close()

    pdf_path = tmp_path / "scanned.pdf"
    pdf_path.write_bytes(pdf_bytes)

    paddle_mock = MagicMock()
    paddle_mock.is_available = MagicMock(return_value=True)
    paddle_mock.async_extract_text_from_bytes = AsyncMock(
        return_value={
            "lines": [
                {"text": "Patient Name: Sneha Sharma", "confidence": 0.98},
                {"text": "Diagnosis: Migraine with Aura", "confidence": 0.95},
                {"text": "Rx: Rizatriptan 10mg PRN", "confidence": 0.96},
            ],
            "full_text": "Patient Name: Sneha Sharma\nDiagnosis: Migraine with Aura\nRx: Rizatriptan 10mg PRN",
            "mean_confidence": 0.9633,
            "min_confidence": 0.95,
            "line_count": 3,
            "char_count": 83,
        }
    )

    vision_mock = AsyncMock()
    vision_mock.extract_image = AsyncMock()

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        vision_service=vision_mock,
        paddle_engine=paddle_mock,
    )
    handler.settings.ocr_concurrent_race_enabled = False

    result = await handler.run_ocr(
        file_path=pdf_path,
        filename="scanned.pdf",
        job_id=uuid4(),
        file_key="scanned.pdf",
        current_pct=15,
        completed_stages=[],
        checkpoint_data={},
    )

    # PaddleOCR was invoked
    paddle_mock.async_extract_text_from_bytes.assert_awaited_once()
    # Vision model was NOT invoked because QualityGate passed
    vision_mock.extract_image.assert_not_called()

    assert result["pages"][0]["engine"] == "paddleocr"
    assert result["pages"][0]["status"] == "SUCCESS"
    assert result["metrics"]["used_paddle_ocr"] is True
    assert result["metrics"]["used_qwen_vl"] is False
    assert result["metrics"]["fallback_count"] == 0
    assert "Sneha Sharma" in result["fullText"]


@pytest.mark.asyncio
async def test_paddle_low_quality_triggers_qwen_fallback(tmp_path: Path):
    """When PaddleOCR yields low-confidence or garbled text, QualityGate triggers Qwen3-VL fallback."""
    doc = fitz.open()
    _page = doc.new_page()
    pdf_bytes = doc.tobytes()
    doc.close()

    pdf_path = tmp_path / "degraded_scan.pdf"
    pdf_path.write_bytes(pdf_bytes)

    # PaddleOCR returns low confidence result (fails quality gate)
    paddle_mock = MagicMock()
    paddle_mock.is_available = MagicMock(return_value=True)
    paddle_mock.async_extract_text_from_bytes = AsyncMock(
        return_value={
            "lines": [{"text": "blurry line", "confidence": 0.55}],
            "full_text": "blurry line",
            "mean_confidence": 0.55,
            "min_confidence": 0.55,
            "line_count": 1,
            "char_count": 11,
        }
    )

    # Qwen3-VL recovers accurate transcription
    vision_mock = AsyncMock()
    vision_mock.extract_image = AsyncMock(
        return_value={
            "text": "Transcribed by Qwen: Patient Name: Johnathan Miller, BP 120/80",
            "confidence": 0.95,
        }
    )

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        vision_service=vision_mock,
        paddle_engine=paddle_mock,
        quality_gate=QualityGate(min_mean_confidence=0.82),
    )
    handler.settings.ocr_concurrent_race_enabled = False

    result = await handler.run_ocr(
        file_path=pdf_path,
        filename="degraded_scan.pdf",
        job_id=uuid4(),
        file_key="degraded_scan.pdf",
        current_pct=15,
        completed_stages=[],
        checkpoint_data={},
    )

    # Both engines called (Paddle tried first, then Qwen fallback)
    paddle_mock.async_extract_text_from_bytes.assert_awaited_once()
    vision_mock.extract_image.assert_awaited_once()

    assert result["pages"][0]["engine"] == "qwen_vl"
    assert result["pages"][0]["status"] == "FALLBACK"
    assert result["metrics"]["fallback_count"] == 1
    assert result["metrics"]["used_paddle_ocr"] is False
    assert result["metrics"]["used_qwen_vl"] is True
    assert "Transcribed by Qwen" in result["fullText"]


@pytest.mark.asyncio
async def test_multi_frame_tiff_routing(tmp_path: Path):
    """Multi-frame TIFF extracts all frames as sequential pages."""
    img1 = Image.new("RGB", (200, 200), color=(255, 255, 255))
    img2 = Image.new("RGB", (200, 200), color=(250, 250, 250))
    buf = io.BytesIO()
    img1.save(buf, format="TIFF", save_all=True, append_images=[img2])
    tiff_bytes = buf.getvalue()

    tiff_path = tmp_path / "multipage_scan.tiff"
    tiff_path.write_bytes(tiff_bytes)

    paddle_mock = MagicMock()
    paddle_mock.is_available = MagicMock(return_value=True)

    async def mock_extract(img_bytes, *args, **kwargs):
        return {
            "lines": [{"text": "Medical Lab Report Header", "confidence": 0.95}],
            "full_text": "Medical Lab Report Header Content Page",
            "mean_confidence": 0.95,
            "min_confidence": 0.95,
            "line_count": 1,
            "char_count": 38,
        }

    paddle_mock.async_extract_text_from_bytes = AsyncMock(side_effect=mock_extract)

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        paddle_engine=paddle_mock,
    )

    result = await handler.run_ocr(
        file_path=tiff_path,
        filename="multipage_scan.tiff",
        job_id=uuid4(),
        file_key="multipage_scan.tiff",
        current_pct=15,
        completed_stages=[],
        checkpoint_data={},
        mime_type="image/tiff",
    )

    assert result["pageCount"] == 2
    assert len(result["pages"]) == 2
    assert result["pages"][0]["page"] == 1
    assert result["pages"][1]["page"] == 2
    assert paddle_mock.async_extract_text_from_bytes.await_count == 2


@pytest.mark.asyncio
async def test_complete_page_failure_inserts_explicit_clinical_marker(tmp_path: Path):
    """When both Paddle and Qwen fail on a page, explicit clinical failure delimiter is inserted."""
    doc = fitz.open()
    _page = doc.new_page()
    pdf_bytes = doc.tobytes()
    doc.close()

    pdf_path = tmp_path / "failed_scan.pdf"
    pdf_path.write_bytes(pdf_bytes)

    # Paddle raises error
    paddle_mock = MagicMock()
    paddle_mock.is_available = MagicMock(return_value=True)
    paddle_mock.async_extract_text_from_bytes = AsyncMock(side_effect=RuntimeError("Paddle segmentation fault"))

    # Qwen also raises error
    vision_mock = AsyncMock()
    vision_mock.extract_image = AsyncMock(side_effect=RuntimeError("Ollama connection refused"))

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        vision_service=vision_mock,
        paddle_engine=paddle_mock,
    )

    result = await handler.run_ocr(
        file_path=pdf_path,
        filename="failed_scan.pdf",
        job_id=uuid4(),
        file_key="failed_scan.pdf",
        current_pct=15,
        completed_stages=[],
        checkpoint_data={},
    )

    assert result["pages"][0]["status"] == "FAILED"
    assert result["pages"][0]["engine"] == "none"
    assert result["metrics"]["failed_page_count"] == 1
    assert "[PAGE 1 OCR FAILED - CLINICAL DATA UNREADABLE]" in result["fullText"]
