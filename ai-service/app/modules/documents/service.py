from __future__ import annotations

import asyncio
import logging
import time
from pathlib import Path

from app.modules.ocr.service import OcrService
from app.modules.summary.service import SummaryService

logger = logging.getLogger(__name__)


class DocumentAiService:
    def __init__(
        self,
        ocr: OcrService,
        summary: SummaryService,
        *,
        summary_from_vision: bool = True,
        slim_response: bool = True,
    ) -> None:
        self.ocr = ocr
        self.summary = summary
        # When the vision model already returns a structured summary,
        # skip the second, slow LLM round-trip entirely. This is the main fix
        # for the ~40s latency.
        self.summary_from_vision = bool(summary_from_vision)
        # Emit a slim response (no duplicated text/lines/paragraphs).
        self.slim_response = bool(slim_response)

    async def process_document_bytes(
        self,
        *,
        document_bytes: bytes,
        filename: str,
        mime_type: str | None,
        mode: str,
        document_type: str,
        slim: bool | None = None,
    ) -> dict:
        total_t0 = time.monotonic()

        # OCR uses the single configured AI model; PDFs stay on the native document path.
        ocr_t0 = time.monotonic()
        extracted = await self.ocr.extract_document_bytes(
            document_bytes=document_bytes,
            filename=filename,
            mime_type=mime_type,
        )
        ocr_ms = int((time.monotonic() - ocr_t0) * 1000)

        extracted_text = extracted.get("text", "")
        logger.info("ocr_extracted_text_result", extra={"document_name": filename, "text_length": len(extracted_text) if extracted_text else 0, "is_text_null": extracted.get("text") is None})

        # ── Summary ─────────────────────────────────────────────────────────
        # Prefer the vision-derived summary returned by the same OCR call.
        # Only fall back to the separate (slower) LLM summary when the vision
        # provider did not supply one and there is text to summarise.
        summary_t0 = time.monotonic()
        vision_summary = extracted.get("visionSummary")
        if self.summary_from_vision and vision_summary is not None:
            summary = vision_summary
            summary_source = "vision"
        elif extracted_text.strip():
            summary = await self.summary.summarize(
                extracted_text,
                mode=mode,
                document_type=document_type,
            )
            summary_source = summary.get("summarySource") or "llm"
        else:
            summary = _empty_summary(mode=mode, document_type=document_type)
            summary_source = "none"
        summary_ms = int((time.monotonic() - summary_t0) * 1000)

        metrics = extracted.get("metrics") or {}
        metrics["ocr_ms"] = ocr_ms
        metrics["summary_ms"] = summary_ms
        metrics["summary_source"] = summary_source

        serialize_t0 = time.monotonic()
        use_slim = self.slim_response if slim is None else bool(slim)
        result = self._build_response(
            extracted=extracted,
            extracted_text=extracted_text,
            summary=summary,
            filename=filename,
            mime_type=mime_type,
            metrics=metrics,
            slim=use_slim,
        )
        serialization_ms = int((time.monotonic() - serialize_t0) * 1000)

        total_ms = int((time.monotonic() - total_t0) * 1000)
        metrics["serialization_ms"] = serialization_ms
        metrics["processing_seconds"] = round(total_ms / 1000, 3)

        # Compact, machine-parseable per-request timing block.
        result["timings"] = {
            **((metrics.get("timings") or {}) if isinstance(metrics.get("timings"), dict) else {}),
            "pdfLoadMs": 0,
            "ocrMs": ocr_ms,
            "summaryMs": summary_ms,
            "serializationMs": serialization_ms,
            "totalMs": total_ms,
        }

        logger.info(
            "document_processed",
            extra={
                "document_name": filename,
                "mime_type": mime_type,
                "page_count": extracted.get("pageCount"),
                "engine": metrics.get("engine"),
                "summary_source": summary_source,
                "ocr_ms": ocr_ms,
                "summary_ms": summary_ms,
                "serialization_ms": serialization_ms,
                "total_ms": total_ms,
                "non_empty_pages": metrics.get("non_empty_pages"),
            },
        )
        return result

    def _build_response(
        self,
        *,
        extracted: dict,
        extracted_text: str,
        summary: dict,
        filename: str,
        mime_type: str | None,
        metrics: dict,
        slim: bool,
    ) -> dict:
        pages = extracted.get("pages", [])
        metadata = {
            "pageCount": extracted.get("pageCount", len(pages)),
            "processedPageCount": extracted.get("processedPageCount", len(pages)),
            "confidence": extracted.get("confidence"),
            "filename": filename,
            "mimeType": mime_type or "application/pdf",
            "engine": metrics.get("engine"),
        }

        doc_type = (summary.get("type") if isinstance(summary, dict) else None) or "general_document"
        sum_eng = ""
        if isinstance(summary, dict) and summary.get("summary"):
            sum_list = summary.get("summary")
            if isinstance(sum_list, list) and len(sum_list) > 0:
                sum_eng = str(sum_list[0])
            elif isinstance(sum_list, str):
                sum_eng = sum_list
        sum_guj = (summary.get("summaryGujarati") if isinstance(summary, dict) else "") or ""

        if slim:
            # Minimal page objects: page number + text only. No `lines`, no
            # `paragraphs`, no duplicated full-text copies. This removes the
            # bulk of the payload and serialization cost.
            slim_pages = [
                {"page": p.get("page"), "text": p.get("text", "")}
                for p in pages
            ]
            return {
                "success": True,
                "documentType": doc_type,
                "summaryEnglish": sum_eng,
                "summaryGujarati": sum_guj,
                "metadata": metadata,
                "pages": slim_pages,
                "fullText": extracted_text,
                "medicalExtraction": extracted.get("medicalExtraction"),
                "summary": summary,
                "metrics": metrics,
            }

        # ── Backward-compatible (verbose) shape ──────────────────────────────
        return {
            "success": True,
            "documentType": doc_type,
            "summaryEnglish": sum_eng,
            "summaryGujarati": sum_guj,
            "ocr": {"pages": pages, "text": extracted_text},
            "summary": summary,
            "metadata": metadata,
            "structuredDocument": extracted,
            "ocr_text": extracted_text,
            "metrics": metrics,
            "used_direct_text": bool(metrics.get("used_direct_text")),
            "used_ocr": bool(metrics.get("used_ocr")),
            "processing_seconds": metrics.get("processing_seconds"),
        }

    async def process_pdf_bytes(
        self,
        *,
        document_bytes: bytes,
        filename: str,
        mime_type: str | None,
        mode: str,
        document_type: str,
        slim: bool | None = None,
    ) -> dict:
        return await self.process_document_bytes(
            document_bytes=document_bytes,
            filename=filename,
            mime_type=mime_type,
            mode=mode,
            document_type=document_type,
            slim=slim,
        )

    async def process_local_file(
        self,
        *,
        source: Path,
        filename: str,
        mime_type: str | None,
        mode: str,
        document_type: str,
        slim: bool | None = None,
    ) -> dict:
        document_bytes = await asyncio.to_thread(source.read_bytes)
        return await self.process_document_bytes(
            document_bytes=document_bytes,
            filename=filename,
            mime_type=mime_type,
            mode=mode,
            document_type=document_type,
            slim=slim,
        )


def _empty_summary(*, mode: str, document_type: str) -> dict:
    return {
        "type": document_type,
        "mode": mode,
        "summary": [],
        "medications": [],
        "tests": [],
        "warnings": [],
        "follow_up": [],
    }
