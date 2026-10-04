from __future__ import annotations

import io
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import fitz  # PyMuPDF
import numpy as np
import pytest
from PIL import Image

from app.core.errors import NonMedicalDocumentException
from app.services.pipeline.ocr_stage import OcrStageHandler
from app.services.pipeline.preprocessing import (
    deskew_image,
    enhance_contrast_and_remove_shadows,
    preprocess_document_image,
)


def create_sample_pdf(text: str) -> bytes:
    doc = fitz.open()
    page = doc.new_page()
    page.insert_text((50, 72), text, fontsize=12)
    pdf_bytes = doc.tobytes()
    doc.close()
    return pdf_bytes


def create_sample_image(text: str = "Medical Report") -> bytes:
    img = Image.new("RGB", (400, 200), color=(255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


@pytest.mark.asyncio
async def test_born_digital_pdf_bypasses_vlm_under_200ms(tmp_path: Path):
    s3_client = MagicMock()
    handler = OcrStageHandler(s3_client=s3_client)

    pdf_text = "Patient Name: Jane Doe\nDiagnosis: Type 2 Diabetes\nRx: Metformin 500mg daily\nBP: 120/80 mmHg"
    pdf_bytes = create_sample_pdf(pdf_text)
    pdf_path = tmp_path / "prescription.pdf"
    pdf_path.write_bytes(pdf_bytes)

    t0 = time.monotonic()
    result = await handler.run_ocr(
        file_path=pdf_path,
        filename="prescription.pdf",
        job_id=uuid4(),
        file_key="prescription.pdf",
        current_pct=15,
        completed_stages=[],
        checkpoint_data={},
    )
    elapsed = time.monotonic() - t0

    assert elapsed < 0.200, f"Born digital fast path took too long: {elapsed}s"
    assert result["metrics"]["used_direct_text"] is True
    assert result["metrics"]["used_ocr"] is False
    assert result["metrics"]["used_ai_model"] is False
    assert "Metformin 500mg" in result["fullText"]
    assert result["confidence"] == 1.0


@pytest.mark.asyncio
async def test_non_medical_document_raises_rejection():
    s3_client = MagicMock()
    handler = OcrStageHandler(s3_client=s3_client)

    bill_text = "BESCOM ELECTRICITY BILL\nAccount No: 123456789\nUnits Consumed: 350 kWh\nAmount Due: Rs 2500\nPayment Due Date: 25-10-2026"
    pdf_bytes = create_sample_pdf(bill_text)

    with pytest.raises(NonMedicalDocumentException) as exc_info:
        await handler.validate_document(
            file_bytes=pdf_bytes,
            filename="electricity_bill.pdf",
            mime_type="application/pdf",
        )

    assert "non-medical utility bill" in str(exc_info.value)


@pytest.mark.asyncio
async def test_ambiguous_medical_document_fails_open():
    s3_client = MagicMock()
    handler = OcrStageHandler(s3_client=s3_client)

    # An ambiguous scan without explicit medical keywords should fail open with warning
    ambiguous_text = "Scan Document Ref #849204\nDate: 12/05/2026\nItem: Routine observation\nDetails: Verified by technician"
    pdf_bytes = create_sample_pdf(ambiguous_text)

    validation_res = await handler.validate_document(
        file_bytes=pdf_bytes,
        filename="scan_849204.pdf",
        mime_type="application/pdf",
    )

    assert validation_res["isValid"] is True
    assert validation_res["isMedical"] is True
    assert validation_res["failOpenUsed"] is True
    assert validation_res["confidence"] == 0.5


def test_image_preprocessing_deskew_and_contrast():
    # Create black and white rectangle image
    img = np.zeros((100, 100, 3), dtype=np.uint8)
    img[20:80, 20:80] = 255

    # Deskew should run cleanly
    deskewed = deskew_image(img, max_angle=45.0)
    assert deskewed is not None
    assert deskewed.shape == img.shape

    # Shadow enhancement should run cleanly
    enhanced = enhance_contrast_and_remove_shadows(img)
    assert enhanced is not None

    # Full pipeline on bytes
    pil_img = Image.fromarray(img)
    buf = io.BytesIO()
    pil_img.save(buf, format="PNG")
    processed_bytes = preprocess_document_image(buf.getvalue(), deskew=True, remove_shadows=True)
    assert processed_bytes is not None
    assert len(processed_bytes) > 0


@pytest.mark.asyncio
async def test_mixed_pdf_routing_preserves_page_ordering(tmp_path: Path):
    """Page 1 has direct text; Page 2 has no text (scanned). Both returned in order."""
    doc = fitz.open()
    p1 = doc.new_page()
    p1.insert_text((50, 72), "Patient Name: Jane Doe\nHbA1c: 6.2%", fontsize=12)
    _p2 = doc.new_page()  # blank page needing OCR
    pdf_bytes = doc.tobytes()
    doc.close()

    pdf_path = tmp_path / "mixed.pdf"
    pdf_path.write_bytes(pdf_bytes)

    vision_mock = AsyncMock()
    vision_mock.page_concurrency = 2
    vision_mock.extract_image = AsyncMock(return_value={"text": "Scanned Page 2 Content", "confidence": 0.95})

    handler = OcrStageHandler(s3_client=MagicMock(), vision_service=vision_mock)
    result = await handler.run_ocr(
        file_path=pdf_path,
        filename="mixed.pdf",
        job_id=uuid4(),
        file_key="mixed.pdf",
        current_pct=15,
        completed_stages=[],
        checkpoint_data={},
    )

    assert result["pageCount"] == 2
    assert len(result["pages"]) == 2
    assert result["pages"][0]["page"] == 1
    assert "HbA1c: 6.2%" in result["pages"][0]["text"]
    assert result["pages"][0]["confidence"] == 1.0

    assert result["pages"][1]["page"] == 2
    assert "Scanned Page 2 Content" in result["pages"][1]["text"]
    assert result["pages"][1]["confidence"] == 0.95

    # Vision model was called only once (for page 2), NOT page 1
    assert vision_mock.extract_image.await_count == 1
    assert result["metrics"]["used_direct_text"] is True
    assert result["metrics"]["used_ocr"] is True


@pytest.mark.asyncio
async def test_partial_page_failure_does_not_abort_document(tmp_path: Path):
    """When one page fails in VLM, other pages succeed and document processing completes."""
    doc = fitz.open()
    _p1 = doc.new_page()  # blank page 1
    _p2 = doc.new_page()  # blank page 2
    pdf_bytes = doc.tobytes()
    doc.close()

    pdf_path = tmp_path / "two_page_scan.pdf"
    pdf_path.write_bytes(pdf_bytes)

    # Page 1 succeeds, Page 2 fails with timeout/exception
    async def mock_extract_image(image_bytes, filename="", **kwargs):
        if "page_2" in filename:
            raise RuntimeError("VLM Connection Timeout on page 2")
        return {"text": "Page 1 Transcribed Text", "confidence": 0.95}

    vision_mock = AsyncMock()
    vision_mock.page_concurrency = 2
    vision_mock.extract_image = AsyncMock(side_effect=mock_extract_image)

    handler = OcrStageHandler(s3_client=MagicMock(), vision_service=vision_mock)
    result = await handler.run_ocr(
        file_path=pdf_path,
        filename="two_page_scan.pdf",
        job_id=uuid4(),
        file_key="two_page_scan.pdf",
        current_pct=15,
        completed_stages=[],
        checkpoint_data={},
    )

    assert result["pageCount"] == 2
    assert result["pages"][0]["page"] == 1
    assert result["pages"][0]["text"] == "Page 1 Transcribed Text"
    assert result["pages"][0]["confidence"] == 0.95

    assert result["pages"][1]["page"] == 2
    assert result["pages"][1]["text"] == ""
    assert result["pages"][1]["confidence"] == 0.0

    # Document-level fullText still contains successful page text
    assert "Page 1 Transcribed Text" in result["fullText"]

