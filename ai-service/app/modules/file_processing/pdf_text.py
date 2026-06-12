from __future__ import annotations

"""Direct PDF text extraction via PyMuPDF."""

import asyncio
import logging
import re
import time
from dataclasses import dataclass
from pathlib import Path
import fitz

logger = logging.getLogger(__name__)

MIN_INFORMATIVE_CHARS_PER_PAGE = 20
MIN_TOTAL_CHARS = 100
MIN_INFORMATIVE_PAGE_FRACTION = 0.4
# Medical lab reports are dominated by numbers, units, ranges, and dates, so a
# high alphabetic ratio is the WRONG signal — it routes valid text PDFs to the
# vision OCR pipeline. We only use alpha_ratio to reject obvious binary/garbage
# extractions, hence a very low floor.
MIN_ALPHA_RATIO = 0.10
# A document with at least this many alphanumeric characters is treated as
# having real, extractable text regardless of the alpha ratio (covers dense
# numeric lab tables).
MIN_ALNUM_CHARS = 80

_WHITESPACE_RUN = re.compile(r"[ \t\f\v]+")
_TRAILING_BLANK_LINES = re.compile(r"\n\s*\n+")


def decode_symbol_pua_text(text: str) -> str:
    """Decode PDFs that expose WinAnsi text through the Unicode PUA.

    Some lab-report PDFs embed normal ASCII text using custom fonts, but
    PyMuPDF returns characters in the private-use range U+F020..U+F0FE.
    For example, ``\uf052\uf065\uf070\uf06f\uf072\uf074`` is actually
    ``Report``. Subtracting 0xF000 restores the original byte/ASCII value.
    """
    if not text:
        return text

    decoded: list[str] = []
    changed = False
    for ch in text:
        code = ord(ch)
        if 0xF020 <= code <= 0xF0FE:
            mapped = code - 0xF000
            # Keep printable ASCII directly. Map common symbolic bullets to a
            # safe separator so downstream text cleanup can read the sentence.
            if 32 <= mapped <= 126:
                decoded.append(chr(mapped))
            elif mapped in {0xD8, 0xD9, 0xDA, 0xDF, 0xE0}:
                decoded.append("•")
            else:
                decoded.append(" ")
            changed = True
        else:
            decoded.append(ch)

    return "".join(decoded) if changed else text


@dataclass(frozen=True)
class DirectPdfPage:
    page_number: int
    text: str
    char_count: int


@dataclass(frozen=True)
class DirectPdfExtraction:
    pages: list[DirectPdfPage]
    full_text: str
    char_count: int
    elapsed_ms: int

    def to_paragraphs(self) -> list[dict]:
        paragraphs: list[dict] = []
        for page in self.pages:
            for order, line in enumerate(_split_lines(page.text)):
                paragraphs.append(
                    {
                        "text": line,
                        "page": page.page_number,
                        "order": order,
                        "label": "paragraph",
                        "confidence": 1.0,
                    }
                )
        return paragraphs

    def to_extraction_result(self) -> dict:
        page_payloads = [
            {
                "page": page.page_number,
                "text": page.text,
                "confidence": 1.0,
                "lines": [
                    {"text": line, "confidence": 1.0}
                    for line in _split_lines(page.text)
                ],
                "elapsed_ms": 0,
            }
            for page in self.pages
        ]
        return {
            "pages": page_payloads,
            "text": self.full_text,
            "fullText": self.full_text,
            "confidence": 1.0,
            "pageCount": len(self.pages),
            "processedPageCount": len(self.pages),
            "paragraphs": self.to_paragraphs(),
        }


def _split_lines(text: str) -> list[str]:
    return [line.strip() for line in (text or "").splitlines() if line.strip()]


def _clean_page_text(raw: str) -> str:
    decoded = decode_symbol_pua_text(raw or "")
    cleaned = _WHITESPACE_RUN.sub(" ", decoded)
    cleaned = _TRAILING_BLANK_LINES.sub("\n\n", cleaned)
    return cleaned.strip()


def _alpha_ratio(text: str) -> float:
    if not text:
        return 0.0
    alpha = sum(1 for ch in text if ch.isalpha())
    return alpha / max(len(text), 1)


def _alnum_count(text: str) -> int:
    return sum(1 for ch in text if ch.isalnum())


def _extract_from_doc(
    doc,
    *,
    max_pages: int | None,
    require_quality: bool = True,
) -> DirectPdfExtraction | None:
    t0 = time.monotonic()
    logger.info("pdf_text_extraction_started", extra={"page_count": int(doc.page_count)})
    pages: list[DirectPdfPage] = []
    full_text_parts: list[str] = []

    page_limit = doc.page_count if max_pages is None else min(max_pages, doc.page_count)
    for index in range(page_limit):
        page_number = index + 1
        try:
            raw = doc.load_page(index).get_text("text") or ""
        except Exception:
            logger.exception("pdf_text_page_failed", extra={"page": page_number})
            raw = ""
        cleaned = _clean_page_text(raw)
        pages.append(
            DirectPdfPage(
                page_number=page_number,
                text=cleaned,
                char_count=len(cleaned),
            )
        )
        if cleaned:
            full_text_parts.append(cleaned)

    full_text = "\n\n".join(full_text_parts).strip()
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    if not pages:
        logger.info("pdf_text_extraction_completed", extra={"page_count": 0, "char_count": 0, "elapsed_ms": elapsed_ms})
        return None

    informative_pages = sum(
        1 for page in pages if page.char_count >= MIN_INFORMATIVE_CHARS_PER_PAGE
    )
    informative_fraction = informative_pages / len(pages)
    alpha_ratio = _alpha_ratio(full_text)
    alnum_chars = _alnum_count(full_text)

    logger.info(
        "pdf_text_extraction_completed",
        extra={
            "page_count": len(pages),
            "char_count": len(full_text),
            "alnum_chars": alnum_chars,
            "informative_pages": informative_pages,
            "informative_fraction": round(informative_fraction, 3),
            "alpha_ratio": round(alpha_ratio, 3),
            "elapsed_ms": elapsed_ms,
        },
    )

    # Accept when the document clearly has real text. Two independent signals:
    #   (a) enough total alphanumerics on enough pages (handles numeric medical
    #       tables that have a LOW alpha ratio), OR
    #   (b) the legacy length+fraction+alpha gate.
    # We only reject when there is genuinely too little text to be useful — in
    # which case the page is image-only/scanned and belongs to the OCR path.
    has_enough_text = (
        alnum_chars >= MIN_ALNUM_CHARS
        and informative_fraction >= MIN_INFORMATIVE_PAGE_FRACTION
        and alpha_ratio >= MIN_ALPHA_RATIO
    )
    legacy_gate = (
        len(full_text) >= MIN_TOTAL_CHARS
        and informative_fraction >= MIN_INFORMATIVE_PAGE_FRACTION
        and alpha_ratio >= MIN_ALPHA_RATIO
    )
    if require_quality and not (has_enough_text or legacy_gate):
        logger.info(
            "pdf_text_insufficient_for_direct",
            extra={
                "char_count": len(full_text),
                "alnum_chars": alnum_chars,
                "alpha_ratio": round(alpha_ratio, 3),
                "informative_fraction": round(informative_fraction, 3),
                "reason": "image_only_or_scanned",
            },
        )
        return None

    if not full_text:
        logger.info(
            "pdf_text_insufficient_for_direct",
            extra={
                "char_count": 0,
                "alnum_chars": 0,
                "alpha_ratio": 0,
                "informative_fraction": 0,
                "reason": "empty_text",
            },
        )
        return None

    logger.info(
        "pdf_text_detected",
        extra={"page_count": len(pages), "char_count": len(full_text), "alnum_chars": alnum_chars},
    )
    return DirectPdfExtraction(
        pages=pages,
        full_text=full_text,
        char_count=len(full_text),
        elapsed_ms=elapsed_ms,
    )


def _extract_bytes_sync(
    pdf_bytes: bytes,
    *,
    max_pages: int | None,
    require_quality: bool = True,
) -> DirectPdfExtraction | None:

    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            return _extract_from_doc(doc, max_pages=max_pages, require_quality=require_quality)
    except Exception:
        logger.exception("pdf_text_open_failed")
        return None


def _extract_path_sync(pdf_path: Path, *, max_pages: int | None) -> DirectPdfExtraction | None:

    try:
        with fitz.open(str(pdf_path)) as doc:
            return _extract_from_doc(doc, max_pages=max_pages)
    except Exception:
        logger.exception("pdf_text_open_failed", extra={"path": str(pdf_path)})
        return None


async def try_extract_pdf_text_from_bytes(
    pdf_bytes: bytes,
    *,
    max_pages: int | None = None,
) -> DirectPdfExtraction | None:
    return await asyncio.to_thread(_extract_bytes_sync, pdf_bytes, max_pages=max_pages, require_quality=True)


async def extract_pdf_text_pages_from_bytes(
    pdf_bytes: bytes,
    *,
    max_pages: int | None = None,
) -> DirectPdfExtraction | None:
    """Return extractable page text without the document-level quality gate.

    OCR routing uses this for the fast first pass. Even when the full document
    would fail the legacy direct-text gate, real text on one or more pages is
    still valuable and should prevent unnecessary vision calls.
    """
    return await asyncio.to_thread(_extract_bytes_sync, pdf_bytes, max_pages=max_pages, require_quality=False)


async def try_extract_pdf_text(
    pdf_path: Path,
    *,
    max_pages: int | None = None,
) -> DirectPdfExtraction | None:
    return await asyncio.to_thread(_extract_path_sync, pdf_path, max_pages=max_pages)
