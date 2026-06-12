from __future__ import annotations

import asyncio

import fitz

from app.modules.file_processing.pdf_text import try_extract_pdf_text_from_bytes
from app.modules.ocr.service import OcrService


def _numeric_medical_pdf(pages: int = 6) -> bytes:
    """Born-digital lab report dominated by numbers/units (low alpha ratio)."""
    doc = fitz.open()
    rows = [
        "Glucose 92 70-100 | HbA1c 5.6 4.0-5.6 | Chol 180 <200",
        "TG 120 <150 | Cr 0.9 0.6-1.2 | Hb 14.2 13-17 | WBC 7.5 4-11",
        "Plt 250 150-400 | Na 140 135-145 | K 4.1 3.5-5.1 | Cl 102 98-107",
        "AST 25 10-40 | ALT 30 7-56 | ALP 70 44-147 | Bili 0.8 0.1-1.2",
        "2024-01-15 09:30 | 98.6 120/80 72 16 99% | 10mg 2x 500mg 3x",
    ]
    for i in range(pages):
        page = doc.new_page(width=595, height=842)
        y = 50
        page.insert_text((50, y), f"LAB REPORT Page {i + 1}", fontsize=12)
        for r in rows:
            y += 22
            page.insert_text((50, y), r, fontsize=10)
    data = doc.tobytes()
    doc.close()
    return data


def _blank_pdf(pages: int = 2) -> bytes:
    doc = fitz.open()
    for _ in range(pages):
        doc.new_page(width=595, height=842)
    data = doc.tobytes()
    doc.close()
    return data


def _single_text_page_pdf(pages: int = 6) -> bytes:
    doc = fitz.open()
    for index in range(pages):
        page = doc.new_page(width=595, height=842)
        if index == 0:
            page.insert_text((50, 80), "Discharge Summary Glucose 92 HbA1c 5.6", fontsize=12)
    data = doc.tobytes()
    doc.close()
    return data


def test_numeric_medical_pdf_routes_to_direct_text() -> None:
    """Regression: low alpha-ratio lab PDFs must NOT be sent to the vision OCR."""
    pdf = _numeric_medical_pdf(6)
    result = asyncio.run(try_extract_pdf_text_from_bytes(pdf, max_pages=25))
    assert result is not None, "numeric medical PDF was wrongly rejected -> would hit vision OCR"
    assert result.char_count > 0
    assert "Glucose 92" in result.full_text


def test_blank_pdf_falls_through_to_ocr() -> None:
    """A PDF with no extractable text must return None (image-only/scanned)."""
    pdf = _blank_pdf(2)
    result = asyncio.run(try_extract_pdf_text_from_bytes(pdf, max_pages=25))
    assert result is None


class _VisionSpy:
    def __init__(self) -> None:
        self.pdf_calls = 0

    def status(self) -> dict:
        return {"engine": "chat-completions"}

    async def extract_pdf(self, pdf_bytes, *, max_pages) -> dict:
        self.pdf_calls += 1
        raise AssertionError("text PDF must never reach the vision engine")

    async def extract_image(self, image_bytes, *, filename, mime_type, max_pages) -> dict:
        raise AssertionError("not expected for a PDF")


def test_ocr_service_never_calls_vision_model_for_text_pdf() -> None:
    spy = _VisionSpy()
    service = OcrService(spy, max_pdf_pages=25, fail_on_empty=True)
    result = asyncio.run(
        service.extract_document_bytes(
            document_bytes=_numeric_medical_pdf(6),
            filename="lab.pdf",
            mime_type="application/pdf",
        )
    )
    assert spy.pdf_calls == 0
    assert result["metrics"]["engine"] == "pymupdf"
    assert result["metrics"]["used_direct_text"] is True
    assert result["metrics"]["used_ocr"] is False


def test_ocr_service_uses_direct_text_when_only_some_pages_have_text() -> None:
    spy = _VisionSpy()
    service = OcrService(spy, max_pdf_pages=25, fail_on_empty=True, min_direct_text_chars=8)
    result = asyncio.run(
        service.extract_document_bytes(
            document_bytes=_single_text_page_pdf(6),
            filename="partial-text.pdf",
            mime_type="application/pdf",
        )
    )
    assert spy.pdf_calls == 0
    assert result["metrics"]["engine"] == "pymupdf"
    assert "Glucose 92" in result["fullText"]


def test_classify_error_recognizes_httpx_timeout() -> None:
    from app.modules.vision.vision_service import _classify_error

    class ReadTimeout(Exception):
        pass

    assert _classify_error(ReadTimeout("The read operation timed out")) == "timeout"
