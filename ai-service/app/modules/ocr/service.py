from __future__ import annotations

import asyncio
import json
import logging
import mimetypes
import time
from pathlib import Path
from typing import Literal

from app.modules.file_processing.pdf_text import (
    DirectPdfExtraction,
    extract_pdf_text_pages_from_bytes,
    try_extract_pdf_text,
)
from app.modules.ocr.cleanup import clean_ocr_text
from app.modules.vision.vision_service import empty_medical_extraction
from app.core.errors import OcrEmptyResultError

logger = logging.getLogger(__name__)

DocumentKind = Literal["pdf", "image"]

PDF_MIME = "application/pdf"
PDF_SUFFIX = ".pdf"

# Canonical MIME types we accept for raster images. JPEG variants and the
# legacy `image/tif` spelling are normalised onto these in `_normalized_mime`.
IMAGE_MIME_TYPES = frozenset(
    {
        "image/png",
        "image/jpeg",
        "image/webp",
    }
)
IMAGE_SUFFIXES = frozenset({".png", ".jpg", ".jpeg", ".webp"})
SUPPORTED_MIME_TYPES = frozenset({PDF_MIME, *IMAGE_MIME_TYPES})
SUPPORTED_EXTENSIONS = frozenset({PDF_SUFFIX, *IMAGE_SUFFIXES})
SUPPORTED_TYPES_MESSAGE = "Supported types: PDF, PNG, JPG, JPEG, WEBP"

_SUFFIX_TO_MIME = {
    ".pdf": PDF_MIME,
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
}
_MIME_ALIASES = {
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
}


class OcrService:
    """Document text-extraction service.

    PDFs are tried with fast PyMuPDF text extraction first and then sent to the
    single configured vision model when they are scanned/image-only. Raster
    images always go straight through that same configured model.
    """

    def __init__(
        self,
        vision_engine,
        *,
        max_pdf_pages: int,
        fail_on_empty: bool = True,
        min_direct_text_chars: int = 8,
    ) -> None:
        self.vision = vision_engine
        self.max_pdf_pages = max(1, int(max_pdf_pages))
        self.min_direct_text_chars = max(1, int(min_direct_text_chars))
        # When True, a vision/OCR extraction that produced zero text on every
        # processed page raises OcrEmptyResultError instead of returning a
        # misleading success. Direct PyMuPDF text (born-digital PDFs) is never
        # gated — its emptiness is authoritative.
        self.fail_on_empty = bool(fail_on_empty)

    async def extract_document_bytes(
        self,
        *,
        document_bytes: bytes,
        filename: str,
        mime_type: str | None,
    ) -> dict:
        logger.info("ocr_extraction_started", extra={"document_name": filename, "mime_type": mime_type})
        if not document_bytes:
            logger.error("ocr_extraction_failed_empty_payload", extra={"document_name": filename})
            raise ValueError("Empty document payload received")
        try:
            result = await self._extract(
                document_bytes=document_bytes,
                filename=filename,
                mime_type=mime_type,
            )
            logger.info("ocr_extraction_completed_successfully", extra={"document_name": filename})
            return result
        except Exception as e:
            logger.error("ocr_extraction_failed", extra={"document_name": filename, "error": str(e)}, exc_info=True)
            raise

    async def extract_document(
        self,
        *,
        source: Path,
        mime_type: str | None,
        file_processing=None,  # retained for backward-compatible call sites
        workspace=None,
    ) -> dict:
        logger.info("ocr_file_extraction_started", extra={"source": str(source), "mime_type": mime_type})
        try:
            document_bytes = await asyncio.to_thread(source.read_bytes)
        except Exception as e:
            logger.error("ocr_file_read_failed", extra={"source": str(source), "error": str(e)}, exc_info=True)
            raise
        try:
            result = await self._extract(
                document_bytes=document_bytes,
                filename=source.name,
                mime_type=mime_type,
            )
            logger.info("ocr_file_extraction_completed_successfully", extra={"source": str(source)})
            return result
        except Exception as e:
            logger.error("ocr_file_extraction_failed", extra={"source": str(source), "error": str(e)}, exc_info=True)
            raise

    async def _extract(
        self,
        *,
        document_bytes: bytes,
        filename: str,
        mime_type: str | None,
    ) -> dict:
        started = time.monotonic()
        timings: dict[str, int] = {}
        decision_started = time.monotonic()
        normalized_mime = _normalized_mime(filename=filename, mime_type=mime_type)
        document_kind = _document_kind(normalized_mime=normalized_mime, filename=filename)
        timings["ocrDecisionMs"] = int((time.monotonic() - decision_started) * 1000)

        # ── Images: no embedded-text path; go straight to the vision engine ──
        if document_kind == "image":
            logger.info("model_ocr_started", extra={"document_name": filename, "kind": "image"})
            ai_started = time.monotonic()
            try:
                payload = await self.vision.extract_image(
                    document_bytes,
                    filename=filename,
                    mime_type=normalized_mime,
                    max_pages=self.max_pdf_pages,
                )
            except Exception as e:
                logger.error("vision_engine_extract_image_failed", extra={"document_name": filename, "error": str(e)}, exc_info=True)
                raise
            timings["aiVisionMs"] = int((time.monotonic() - ai_started) * 1000)
            self._guard_empty_result(payload, filename=filename)
            return _finalize(payload, started=started, mime_type=normalized_mime, timings=timings)

        # ── PDFs: try embedded text FIRST. If found, return immediately and
        # skip the expensive vision model and image rendering path. This is the single
        # most important routing decision for latency. ──────────────────────
        pdf_text_started = time.monotonic()
        direct = await extract_pdf_text_pages_from_bytes(
            document_bytes,
            max_pages=self.max_pdf_pages,
        )
        timings["pdfTextExtractionMs"] = int((time.monotonic() - pdf_text_started) * 1000)
        if direct is not None and direct.char_count >= self.min_direct_text_chars:
            logger.info(
                "pdf_text_returned_without_ocr",
                extra={
                    "document_name": filename,
                    "page_count": len(direct.pages),
                    "char_count": direct.char_count,
                    "threshold": self.min_direct_text_chars,
                    "elapsed_ms": int((time.monotonic() - started) * 1000),
                },
            )
            return _direct_payload(direct, started=started, mime_type=normalized_mime, timings=timings)

        if direct is not None:
            logger.info(
                "pdf_text_below_direct_threshold_using_vision_engine",
                extra={
                    "document_name": filename,
                    "page_count": len(direct.pages),
                    "char_count": direct.char_count,
                    "threshold": self.min_direct_text_chars,
                },
            )

        # ── Image-only / scanned PDF → vision OCR ────────────────────────────
        logger.info(
            "pdf_text_unavailable_using_vision_engine",
            extra={"document_name": filename},
        )
        logger.info("ai_request_started", extra={"document_name": filename})
        ai_started = time.monotonic()
        try:
            payload = await self.vision.extract_pdf(
                document_bytes, max_pages=self.max_pdf_pages
            )
        except Exception as e:
            logger.error("vision_engine_extract_pdf_failed", extra={"document_name": filename, "error": str(e)}, exc_info=True)
            raise
        timings["aiVisionMs"] = int((time.monotonic() - ai_started) * 1000)
        logger.info(
            "ai_request_completed",
            extra={
                "document_name": filename,
                "non_empty_pages": (payload.get("metrics") or {}).get("non_empty_pages"),
                "fallback_used": False,
                "elapsed_ms": timings["aiVisionMs"],
            },
        )
        self._guard_empty_result(payload, filename=filename)
        return _finalize(payload, started=started, mime_type=normalized_mime, timings=timings)

    def _guard_empty_result(self, payload: dict, *, filename: str) -> None:
        """Reject a silent-success when OCR produced no text on any page.

        A document whose pages were all genuinely *blank* is a legitimate empty
        result and is allowed through. But when pages came back empty due to a
        recoverable failure (upstream timeout, transport/HTTP error, or the
        model returning nothing for a non-blank page), returning
        ``success=true`` with empty content hides a real failure — so we raise
        instead, mapped to HTTP 422 by the error handler.
        """
        if not self.fail_on_empty:
            return
        metrics = payload.get("metrics") or {}
        non_empty = metrics.get("non_empty_pages")
        if non_empty is None:
            non_empty = sum(1 for page in payload.get("pages", []) if (page.get("text") or "").strip())
        if non_empty and non_empty > 0:
            return

        page_errors = [err for err in (metrics.get("page_errors") or []) if err]
        # All pages blank and no error → the document really is empty. Allow it.
        recoverable = {"http_error", "timeout", "transport_error", "exhausted", "unknown", "empty_response"}
        if not page_errors or not (set(page_errors) & recoverable):
            logger.info(
                "ocr_empty_but_blank_document",
                extra={"document_name": filename, "page_errors": ",".join(sorted(set(page_errors))) if page_errors else "none"},
            )
            return

        logger.error(
            "ocr_empty_result_rejected",
            extra={
                "document_name": filename,
                "processed_pages": metrics.get("processedPageCount") or payload.get("processedPageCount"),
                "page_errors": ",".join(sorted(set(page_errors))) if page_errors else None,
                "model": metrics.get("model"),
            },
        )
        detail = (
            "OCR produced no text on any page. This usually means the vision "
            "model timed out, was unreachable, returned invalid JSON, or the "
            "page images were not received. Check AI_MODEL, AI_TIMEOUT_SECONDS, "
            "and AI_BASE_URL availability."
        )
        if page_errors:
            detail += f" Page errors: {', '.join(sorted(set(page_errors)))}."
        raise OcrEmptyResultError(
            detail,
            details={
                "filename": filename,
                "pageErrors": sorted(set(page_errors)),
                "processedPageCount": payload.get("processedPageCount"),
            },
        )

    def status(self) -> dict:
        engine_status = self.vision.status() if self.vision else {}
        return {
            "engine": engine_status.get("engine", "unknown"),
            "maxPdfPages": self.max_pdf_pages,
            "failOnEmpty": self.fail_on_empty,
            "supportedExtensions": sorted(SUPPORTED_EXTENSIONS),
            "supportedMimeTypes": sorted(SUPPORTED_MIME_TYPES),
            "vision": engine_status,
        }


def _normalized_mime(*, filename: str, mime_type: str | None) -> str:
    """Resolve a canonical MIME type from the supplied type or the filename."""
    explicit = (mime_type or "").split(";")[0].strip().lower()
    guessed = (mimetypes.guess_type(filename)[0] or "").lower()
    value = explicit or guessed
    value = _MIME_ALIASES.get(value, value)
    if value:
        return value
    return _SUFFIX_TO_MIME.get(Path(filename).suffix.lower(), "")


def _document_kind(*, normalized_mime: str, filename: str) -> DocumentKind:
    suffix = Path(filename).suffix.lower()
    if normalized_mime == PDF_MIME or suffix == PDF_SUFFIX:
        return "pdf"
    if normalized_mime in IMAGE_MIME_TYPES or suffix in IMAGE_SUFFIXES:
        return "image"
    raise ValueError(f"Unsupported document type. {SUPPORTED_TYPES_MESSAGE}")


def _finalize(payload: dict, *, started: float, mime_type: str, timings: dict[str, int] | None = None) -> dict:
    metrics = payload.setdefault("metrics", {})
    metrics["processing_seconds"] = round(time.monotonic() - started, 3)
    metrics["mime_type"] = mime_type
    metrics.setdefault("timings", {})
    if timings:
        metrics["timings"].update(timings)
    metrics["timings"]["ocrTotalMs"] = int((time.monotonic() - started) * 1000)
    logger.info("ocr_performance_summary", extra={"timings": json.dumps(metrics["timings"], sort_keys=True)})
    return payload


def _direct_payload(
    direct: DirectPdfExtraction,
    *,
    started: float,
    mime_type: str,
    timings: dict[str, int] | None = None,
) -> dict:
    payload = direct.to_extraction_result()
    cleaned = clean_ocr_text(payload["fullText"])
    payload["text"] = cleaned
    payload["fullText"] = cleaned
    payload["medicalExtraction"] = empty_medical_extraction()
    payload["metrics"] = {
        "used_direct_text": True,
        "used_ocr": False,
        "direct_extraction_ms": direct.elapsed_ms,
        "vision_ms": 0,
        "processing_seconds": round(time.monotonic() - started, 3),
        "engine": "pymupdf",
        "mime_type": mime_type or PDF_MIME,
    }
    if timings:
        payload["metrics"]["timings"] = {**timings, "ocrTotalMs": int((time.monotonic() - started) * 1000)}
    logger.info(
        "extract_document_direct",
        extra={
            "page_count": payload["pageCount"],
            "char_count": len(cleaned),
            "elapsed_ms": int((time.monotonic() - started) * 1000),
        },
    )
    return payload
