from __future__ import annotations

import asyncio
import contextlib
import io
import logging
import os
import re
import time
from pathlib import Path
from typing import Any
from uuid import UUID

import fitz  # PyMuPDF
from PIL import Image, ImageSequence

from app.constants.stages import (
    STAGE_OCR_RUNNING,
    STAGE_UPLOADING,
    STAGE_VALIDATING,
    STATUS_IN_PROGRESS,
)
from app.core.errors import NonMedicalDocumentException, OcrEmptyResultError
from app.infrastructure.storage.s3 import CorruptFileException, S3StorageClient
from app.modules.file_processing.office_text import try_extract_office_text_from_bytes
from app.modules.file_processing.pdf_text import (
    DirectPdfExtraction,
    PageTextValidationResult,
    extract_pdf_text_pages_from_bytes,
    validate_page_direct_text,
)
from app.modules.ocr.cache import OcrResultCache
from app.modules.ocr.quality_gate import QualityGate
from app.services.pipeline.lifecycle_service import PipelineLifecycleService
from app.services.pipeline.preprocessing import preprocess_document_image

logger = logging.getLogger(__name__)


@contextlib.contextmanager
def ocr_timer(step_name: str, **extra: Any):
    """Context-manager timer for attributing OCR stage execution sub-steps."""
    t_start = time.monotonic()
    result = {"elapsed_ms": 0}
    try:
        yield result
    finally:
        result["elapsed_ms"] = int((time.monotonic() - t_start) * 1000)
        extra_str = f" ({', '.join(f'{k}={v}' for k, v in extra.items())})" if extra else ""
        logger.info("%s: %d ms%s", step_name, result["elapsed_ms"], extra_str)

SUPPORTED_MIME_TYPES = {
    "application/pdf",
    "image/png",
    "image/jpeg",
    "image/jpg",
    "image/webp",
    "image/tiff",
    "image/tif",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/msword",
}
SUPPORTED_EXTENSIONS = {
    ".pdf",
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".tiff",
    ".tif",
    ".docx",
    ".doc",
}

NON_MEDICAL_PATTERNS = [
    r"\b(electricity bill|electric bill|power corporation|bescom|tneb|mseb|discom)\b",
    r"\b(water bill|gas utility|broadband bill|internet bill|telecom bill)\b",
    r"\b(supermarket|grocery store|restaurant bill|dining receipt|fast food|coffee shop)\b",
    r"\b(hardware store|apparel|clothing receipt|furniture invoice|hotel stay receipt)\b",
    r"\b(software subscription invoice|cloud hosting bill|aws invoice|azure invoice)\b",
    r"\b(fuel receipt|petrol pump|toll receipt|parking ticket|boarding pass)\b",
]

MEDICAL_INDICATORS = [
    r"\b(patient|hospital|clinic|doctor|physician|dr\.|prescription|rx|medication|tablet|capsule|mg|dosage)\b",
    r"\b(diagnosis|symptoms|chief complaint|discharge summary|opd|ipd|consultation|investigation)\b",
    r"\b(lab report|pathology|biochemistry|hematology|urine|blood|serum|hemoglobin|rbc|wbc|platelets)\b",
    r"\b(glucose|sugar|cholesterol|creatinine|urea|bilirubin|tsh|sgot|sgpt|lipid|ecg|ekg|x-ray|mri|ct scan|ultrasound)\b",
    r"\b(vaccination|immunization|dose|vital signs|bp|pulse|spo2|temperature)\b",
]


class OcrStageHandler:
    def __init__(
        self,
        s3_client: S3StorageClient,
        lifecycle: PipelineLifecycleService | None = None,
        vision_service: Any = None,
        paddle_engine: Any = None,
        quality_gate: Any = None,
        min_direct_text_chars: int = 8,
        cache: OcrResultCache | None = None,
    ) -> None:
        self.s3_client = s3_client
        self.lifecycle = lifecycle
        self.vision = vision_service
        self.paddle = paddle_engine
        self.quality_gate = quality_gate or QualityGate()
        self.min_direct_text_chars = min_direct_text_chars
        self.cache = cache

    # ─────────────────────────────────────────────────────────────────────────
    # STAGE 1: VALIDATING
    # ─────────────────────────────────────────────────────────────────────────
    async def validate_document(
        self,
        file_bytes: bytes,
        filename: str,
        mime_type: str | None = None,
    ) -> dict[str, Any]:
        """Fast MIME inspection, header checking, and medical gate classifier.
        Fails OPEN on ambiguous medical scans; strictly rejects non-medical receipts/bills.
        """
        logger.info("Validating document: filename=%s, mime_type=%s", filename, mime_type)
        if not file_bytes:
            raise ValueError("Document payload is empty")

        ext = Path(filename).suffix.lower()
        if ext and ext not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported file extension: {ext}. Supported: {SUPPORTED_EXTENSIONS}")

        if mime_type and mime_type.lower() not in SUPPORTED_MIME_TYPES and ext not in SUPPORTED_EXTENSIONS:
            raise ValueError(f"Unsupported MIME type: {mime_type}. Supported: {SUPPORTED_MIME_TYPES}")

        # Quick text probe for PDFs or office documents for early gate
        sample_text = ""
        is_pdf = ext == ".pdf" or file_bytes.startswith(b"%PDF")
        if is_pdf:
            try:
                with fitz.open(stream=file_bytes, filetype="pdf") as doc:
                    if doc.page_count > 0:
                        sample_text = doc.load_page(0).get_text("text") or ""
            except Exception as e:
                logger.warning("Could not sample PDF text during validation: %s", e)
        elif ext in {".docx", ".doc"}:
            try:
                office_res = try_extract_office_text_from_bytes(file_bytes, filename)
                if office_res:
                    sample_text = office_res.full_text[:500]
            except Exception as e:
                logger.warning("Could not sample office text during validation: %s", e)

        # Check for pure non-medical patterns
        check_text = (sample_text + " " + filename).lower()
        has_medical = any(re.search(pat, check_text, re.IGNORECASE) for pat in MEDICAL_INDICATORS)
        is_non_medical = any(re.search(pat, check_text, re.IGNORECASE) for pat in NON_MEDICAL_PATTERNS)

        if is_non_medical and not has_medical:
            logger.warning("Document classified as NON-MEDICAL: %s", filename)
            raise NonMedicalDocumentException(
                f"The uploaded document '{filename}' is recognized as a non-medical utility bill or commercial receipt. Please upload a medical report, prescription, or clinical summary."
            )

        # Ambiguous documents fail open per HF-3 hotfix
        validation_result = {
            "isValid": True,
            "isMedical": True,
            "confidence": 0.95 if has_medical else 0.5,
            "failOpenUsed": not has_medical,
            "filename": filename,
            "mimeType": mime_type or ("application/pdf" if is_pdf else "image/jpeg"),
            "fileSize": len(file_bytes),
        }
        logger.info("Validation passed for %s (failOpenUsed=%s)", filename, validation_result["failOpenUsed"])
        return validation_result

    # ─────────────────────────────────────────────────────────────────────────
    # STAGE 2: UPLOADING
    # ─────────────────────────────────────────────────────────────────────────
    async def verify_upload(
        self,
        bucket: str,
        key: str,
        expected_sha256: str | None = None,
    ) -> Path:
        """Verify storage pointer accessibility and SHA-256 integrity digest."""
        logger.info("Verifying upload storage pointer: s3://%s/%s", bucket, key)
        temp_path = await self.s3_client.download_to_temp_file(
            bucket=bucket,
            key=key,
            expected_sha256=expected_sha256,
        )
        if not temp_path.exists() or temp_path.stat().st_size == 0:
            raise CorruptFileException(f"Downloaded file is empty or missing: {temp_path}")
        return temp_path

    async def _extract_page_with_tiered_ocr(
        self,
        img_bytes: bytes,
        page_num: int,
        mime: str = "image/jpeg",
    ) -> dict[str, Any]:
        """Tiered extraction for a single rendered page or image:
        1. Try PaddleOCR primary.
        2. Evaluate via QualityGate.
        3. If QualityGate fails or Paddle error, fallback to VisionModelService (Qwen3-VL).
        4. If Vision fails too, mark FAILED without aborting whole document.
        """
        page_start = time.monotonic()
        page_text = ""
        confidence = 0.0
        lines: list[dict[str, Any]] = []
        engine_used = "none"
        status = "FAILED"
        fallback_reason = None
        error_msg = None
        page_telemetry: dict[str, Any] = {}

        # ── Step 0: Check SHA-256 Result Cache ──
        if self.cache is not None:
            config_hash = getattr(self.paddle, "config_hash", "") if self.paddle else ""
            cached_res = self.cache.get(img_bytes, engine_config_hash=config_hash)
            if cached_res is not None:
                cached_res["page"] = page_num
                logger.info("Page %d OCR cache hit (SHA-256 key, elapsed_ms=%d)", page_num, cached_res.get("elapsed_ms", 0))
                return cached_res

        with ocr_timer("preprocess_ms", page=page_num, bytes_len=len(img_bytes)):
            pass

        target_lang = "en"
        with ocr_timer("lang_detect_ms", page=page_num, lang=target_lang):
            target_lang = getattr(self.paddle, "lang", "en") if self.paddle else "en"

        paddle_available = False
        with ocr_timer("model_load_ms", engine="paddleocr", page=page_num):
            paddle_available = bool(self.paddle and getattr(self.paddle, "is_available", lambda: True)())
            if not paddle_available:
                if self.paddle and getattr(self.paddle, "_init_error", None) is not None:
                    fallback_reason = f"primary_init_failed: {self.paddle._init_error}"
                elif not self.paddle:
                    fallback_reason = "primary_not_configured"

        # ── Step 1: Try PaddleOCR if configured ──
        if paddle_available:
            try:
                with ocr_timer("ocr_infer_ms", engine="paddleocr", lang=target_lang, pass_num=1, page=page_num):
                    paddle_res = await self.paddle.async_extract_text_from_bytes(img_bytes)
                with ocr_timer("postprocess_ms", engine="paddleocr", page=page_num):
                    gate_result = self.quality_gate.evaluate(paddle_res)
                    min_conf = getattr(getattr(self, "settings", None), "ocr_router_min_confidence", 0.82)
                    mean_c = float(paddle_res.get("mean_confidence") or 0.0)
                    low_conf_ratio = float(gate_result.details.get("low_confidence_line_ratio") or 0.0)

                    timings = paddle_res.get("timings") or {}
                    page_telemetry.update({
                        "get_instance_ms": timings.get("get_instance_ms", 0),
                        "engine_init_ms": timings.get("engine_init_ms", 0),
                        "image_decode_ms": timings.get("image_decode_ms", 0),
                        "detector_ms": timings.get("detector_ms", 0),
                        "recognizer_ms": timings.get("recognizer_ms", 0),
                        "result_conversion_ms": timings.get("result_conversion_ms", 0),
                        "total_ocr_ms": timings.get("total_ocr_ms", 0),
                        "worker_pid": paddle_res.get("worker_pid"),
                    })
                    logger.info(
                        "Page %d PaddleOCR timings: total=%d ms, det=%d ms, rec=%d ms, decode=%d ms, conv=%d ms, engine_init=%d ms, pid=%s (lines=%d, conf=%.4f)",
                        page_num,
                        timings.get("total_ocr_ms", 0),
                        timings.get("detector_ms", 0),
                        timings.get("recognizer_ms", 0),
                        timings.get("image_decode_ms", 0),
                        timings.get("result_conversion_ms", 0),
                        timings.get("engine_init_ms", 0),
                        paddle_res.get("worker_pid"),
                        paddle_res.get("line_count", 0),
                        mean_c,
                    )

                    # Accept primary engine if quality gate passed OR if mean confidence >= router threshold and low confidence line ratio is small,
                    # provided no unread regional/non-Latin scripts were detected (zero-silent-drop invariant MULTI-02)
                    can_bypass_low_conf = (
                        mean_c >= min_conf
                        and low_conf_ratio <= 0.15
                    )
                    if (gate_result.passed or can_bypass_low_conf) and not gate_result.has_unread_non_latin:
                        page_text = paddle_res.get("full_text") or ""
                        confidence = mean_c or 0.95
                        lines = paddle_res.get("lines") or []
                        engine_used = "paddleocr"
                        status = "SUCCESS"
                        fallback_reason = None
                    else:
                        fallback_reason = gate_result.reason
                        logger.info("Page %d PaddleOCR quality gate failed: %s", page_num, fallback_reason)
            except Exception as p_err:
                fallback_reason = f"PaddleOCR exception: {p_err}"
                logger.warning("Page %d PaddleOCR exception: %s", page_num, p_err)

        # ── Step 2: Fallback to Vision Model (Qwen3-VL) if needed ──
        if status != "SUCCESS" and self.vision:
            try:
                logger.info(
                    "Routing page %d to Vision Model (fallback_reason=%s)",
                    page_num,
                    fallback_reason or "Primary engine not configured",
                )
                with ocr_timer("ocr_infer_ms", engine="qwen_vl", lang="en", pass_num=2, page=page_num):
                    res = await self.vision.extract_image(
                        img_bytes,
                        filename=f"page_{page_num}.jpg",
                        mime_type=mime,
                        max_pages=1,
                    )
                page_telemetry = (res.get("metrics") or {}).get("telemetry") or {}
                with ocr_timer("postprocess_ms", engine="qwen_vl", page=page_num):
                    raw_vision_text = (res.get("text") or "").strip()
                    vision_conf = float(res.get("confidence") or 0.95) if raw_vision_text else 0.0

                    from app.modules.ocr.script_detector import detect_scripts_in_text

                    if fallback_reason == "UNREAD_NON_LATIN_SCRIPT" and paddle_res and paddle_res.get("lines"):
                        # Preserve accurate English lines from PaddleOCR
                        retained_lines = [
                            l for l in paddle_res["lines"]
                            if float(l.get("confidence") or 0.0) >= 0.70 and not any(k in str(l.get("text", "")) for k in ["Eqy", "qyu"])
                        ]
                        # Extract non-Latin lines from Vision Model transcription
                        non_latin_lines = [
                            l.strip() for l in raw_vision_text.splitlines()
                            if detect_scripts_in_text(l).get("has_non_latin")
                        ]
                        if non_latin_lines:
                            for nl in non_latin_lines:
                                retained_lines.append({"text": nl, "confidence": 0.95})
                            lines = retained_lines
                            page_text = "\n".join(l["text"] for l in lines)
                            confidence = round(sum(float(l.get("confidence") or 0.95) for l in lines) / len(lines), 4)
                            engine_used = "hybrid_paddle_vlm"
                        else:
                            page_text = raw_vision_text
                            lines = [{"text": l.strip(), "confidence": vision_conf} for l in raw_vision_text.splitlines() if l.strip()]
                            confidence = vision_conf
                            engine_used = "qwen_vl"
                    else:
                        page_text = raw_vision_text
                        lines = [
                            {"text": l.strip(), "confidence": vision_conf}
                            for l in raw_vision_text.splitlines()
                            if l.strip()
                        ]
                        confidence = vision_conf
                        engine_used = "qwen_vl"

                    status = "FALLBACK" if fallback_reason else "SUCCESS"
            except Exception as v_err:
                error_msg = str(v_err)
                logger.warning("Vision OCR failed on page %d: %s", page_num, v_err)
                page_text = ""
                confidence = 0.0
                lines = []
                engine_used = "none"
                status = "FAILED"

        elapsed_page_ms = int((time.monotonic() - page_start) * 1000)
        res = {
            "page": page_num,
            "text": page_text,
            "confidence": confidence,
            "lines": lines,
            "elapsed_ms": elapsed_page_ms,
            "engine": engine_used,
            "status": status,
            "fallback_reason": fallback_reason,
            "error": error_msg,
            "cached": False,
            "telemetry": page_telemetry,
        }

        # Cache successful page OCR extractions (zero cache poisoning)
        if status in {"SUCCESS", "FALLBACK"} and self.cache is not None and page_text:
            config_hash = getattr(self.paddle, "config_hash", "") if self.paddle else ""
            self.cache.set(img_bytes, res, engine_config_hash=config_hash)

        return res

    # ─────────────────────────────────────────────────────────────────────────
    # STAGE 3: OCR_RUNNING
    # ─────────────────────────────────────────────────────────────────────────
    async def run_ocr(
        self,
        file_path: Path,
        filename: str,
        job_id: UUID,
        file_key: str,
        current_pct: int,
        completed_stages: list[str],
        checkpoint_data: dict[str, Any],
        mime_type: str | None = None,
    ) -> dict[str, Any]:
        """Execute tiered OCR processing:
        1. DOCX/DOC: Direct office XML text extraction (<10ms).
        2. Born-Digital PDF: Direct vector text extraction (<50ms).
        3. Scanned PDF / Multi-frame TIFF / Raster images: PaddleOCR primary with QualityGate
           and Qwen3-VL fallback.
        Emits per-page progressive SSE notifications and isolates page failures.
        """
        t0 = time.monotonic()
        ext = file_path.suffix.lower() or Path(filename).suffix.lower()
        with ocr_timer("preprocess_ms", file=filename):
            file_bytes = await asyncio.to_thread(file_path.read_bytes)

        # ── 1. Office Document Fast Path (DOCX / DOC) ─────────────────────────
        if ext in {".docx", ".doc"}:
            office_res = try_extract_office_text_from_bytes(file_bytes, filename)
            if office_res and office_res.full_text:
                elapsed_ms = int((time.monotonic() - t0) * 1000)
                logger.info(
                    "Office document (%s) extracted in %dms without VLM (chars=%d)",
                    ext,
                    elapsed_ms,
                    office_res.char_count,
                )
                pages_data = [
                    {
                        "page": 1,
                        "text": office_res.full_text,
                        "confidence": 1.0,
                        "lines": office_res.lines,
                        "elapsed_ms": elapsed_ms,
                        "engine": "office_direct",
                        "status": "SUCCESS",
                    }
                ]
                if self.lifecycle:
                    await self.lifecycle.report_progress(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_OCR_RUNNING,
                        stage_status=STATUS_IN_PROGRESS,
                        previous_percentage=current_pct,
                        message="Extracting page 1 of 1",
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        page=1,
                        total_pages=1,
                    )
                return {
                    "pages": pages_data,
                    "fullText": office_res.full_text,
                    "text": office_res.full_text,
                    "confidence": 1.0,
                    "pageCount": 1,
                    "processedPageCount": 1,
                    "detectedLanguages": ["english"],
                    "metrics": {
                        "used_direct_text": True,
                        "used_ocr": False,
                        "used_paddle_ocr": False,
                        "used_ai_model": False,
                        "used_qwen_vl": False,
                        "fallback_count": 0,
                        "failed_page_count": 0,
                        "page_count": 1,
                        "processing_seconds": round(elapsed_ms / 1000.0, 3),
                        "elapsed_ms": elapsed_ms,
                    },
                }

        # ── 2. PDF Document Routing (Per-Page Hybrid Direct Vector vs Scanned Tiered) ───
        is_pdf = ext == ".pdf" or filename.lower().endswith(".pdf") or file_bytes.startswith(b"%PDF")
        routing_decisions: list[dict[str, Any]] = []
        if is_pdf:
            try:
                with fitz.open(stream=file_bytes, filetype="pdf") as doc:
                    total_p = doc.page_count
                    pages_data_dict: dict[int, dict[str, Any]] = {}

                    # Evaluate every page individually with validate_page_direct_text
                    for index in range(total_p):
                        page_num = index + 1
                        try:
                            raw_text = doc.load_page(index).get_text("text") or ""
                        except Exception as page_read_err:
                            logger.warning("Failed to read direct text on page %d: %s", page_num, page_read_err)
                            raw_text = ""

                        val_res = validate_page_direct_text(doc, page_number=page_num, text=raw_text)
                        if val_res.is_valid_direct_text and len(val_res.text.strip()) >= self.min_direct_text_chars:
                            lines = [
                                {"text": line.strip(), "confidence": 1.0}
                                for line in val_res.text.splitlines()
                                if line.strip()
                            ]
                            pages_data_dict[page_num] = {
                                "page": page_num,
                                "text": val_res.text,
                                "confidence": 1.0,
                                "lines": lines,
                                "elapsed_ms": 0,
                                "engine": "pymupdf_direct",
                                "status": "SUCCESS",
                            }
                            routing_decisions.append({
                                "page": page_num,
                                "decision": "pymupdf_direct",
                                "reason": None,
                            })
                            logger.info("Page %d routed to PyMuPDF direct text", page_num)
                        else:
                            routing_decisions.append({
                                "page": page_num,
                                "decision": "raster_ocr",
                                "reason": val_res.rejection_reason,
                            })
                            logger.info(
                                "Page %d routed to raster OCR (rejection_reason=%s)",
                                page_num,
                                val_res.rejection_reason,
                            )

                    # Fast-path: If ALL pages are valid direct text, return immediately (<50ms per page)
                    if len(pages_data_dict) == total_p and total_p > 0:
                        elapsed_ms = int((time.monotonic() - t0) * 1000)
                        pages_data = [pages_data_dict[p] for p in range(1, total_p + 1)]
                        full_text = "\n\n".join(p["text"] for p in pages_data if p.get("text")).strip()

                        # Progressive page notifications
                        if self.lifecycle:
                            for page_item in pages_data:
                                await self.lifecycle.report_progress(
                                    job_id=job_id,
                                    file_key=file_key,
                                    stage=STAGE_OCR_RUNNING,
                                    stage_status=STATUS_IN_PROGRESS,
                                    previous_percentage=current_pct,
                                    message=f"Extracting page {page_item['page']} of {total_p}",
                                    completed_stages=completed_stages,
                                    checkpoint_data=checkpoint_data,
                                    page=page_item["page"],
                                    total_pages=total_p,
                                )

                        return {
                            "pages": pages_data,
                            "fullText": full_text,
                            "text": full_text,
                            "confidence": 1.0,
                            "pageCount": total_p,
                            "processedPageCount": total_p,
                            "detectedLanguages": ["english"],
                            "metrics": {
                                "used_direct_text": True,
                                "used_ocr": False,
                                "used_paddle_ocr": False,
                                "used_ai_model": False,
                                "used_qwen_vl": False,
                                "fallback_count": 0,
                                "failed_page_count": 0,
                                "page_count": total_p,
                                "direct_text_page_count": total_p,
                                "raster_ocr_page_count": 0,
                                "per_page_routing_decisions": routing_decisions,
                                "hybrid_extraction": False,
                                "processing_seconds": round(elapsed_ms / 1000.0, 3),
                                "elapsed_ms": elapsed_ms,
                            },
                        }

                    # Mixed / Scanned PDF: Rasterize remaining pages needing OCR
                    scanned_page_nums = [p for p in range(1, total_p + 1) if p not in pages_data_dict]
                    if scanned_page_nums:
                        concurrency = getattr(self.vision, "page_concurrency", 2) or 2
                        concurrency = max(1, min(int(concurrency), 4))
                        semaphore = asyncio.Semaphore(concurrency)
                        logger.info(
                            "Routing %d scanned / corrupted pages to raster OCR with concurrency=%d",
                            len(scanned_page_nums),
                            concurrency,
                        )

                        async def process_scanned_page(page_num: int) -> dict[str, Any]:
                            async with semaphore:
                                try:
                                    with ocr_timer("render_ms", page=page_num, format="pdf"):
                                        page = doc.load_page(page_num - 1)
                                        pix = page.get_pixmap(dpi=150, alpha=False)
                                        try:
                                            img_bytes = pix.tobytes("jpeg", jpg_quality=88)
                                            mime = "image/jpeg"
                                        except Exception:
                                            img_bytes = pix.tobytes("png")
                                            mime = "image/png"
                                    return await self._extract_page_with_tiered_ocr(
                                        img_bytes, page_num, mime=mime
                                    )
                                except Exception as err:
                                    logger.warning("Render failed on page %d: %s", page_num, err)
                                    return {
                                        "page": page_num,
                                        "text": "",
                                        "confidence": 0.0,
                                        "lines": [],
                                        "elapsed_ms": 0,
                                        "engine": "none",
                                        "status": "FAILED",
                                        "error": str(err),
                                    }

                        scanned_results = await asyncio.gather(
                            *(process_scanned_page(p) for p in scanned_page_nums)
                        )
                        for r in scanned_results:
                            pages_data_dict[r["page"]] = r

                    # Reassemble pages in exact sequential order
                    pages_data = [pages_data_dict[p] for p in range(1, total_p + 1)]
            except Exception as exc:
                logger.error("Failed to process PDF pages: %s", exc)
                raise OcrEmptyResultError(f"Failed to process PDF pages: {exc}")

        # ── 3. Multi-Frame TIFF Document Routing ──────────────────────────────
        elif ext in {".tiff", ".tif"} or (mime_type and "tiff" in mime_type.lower()):
            try:
                with Image.open(io.BytesIO(file_bytes)) as pil_img:
                    frames = list(ImageSequence.Iterator(pil_img))
                    total_p = max(1, len(frames))
                    concurrency = getattr(self.vision, "page_concurrency", 2) or 2
                    concurrency = max(1, min(int(concurrency), 4))
                    semaphore = asyncio.Semaphore(concurrency)

                    async def process_tiff_frame(frame_idx: int, frame_img: Image.Image) -> dict[str, Any]:
                        async with semaphore:
                            with ocr_timer("render_ms", page=frame_idx, format="tiff"):
                                buf = io.BytesIO()
                                frame_img.convert("RGB").save(buf, format="JPEG", quality=88)
                            return await self._extract_page_with_tiered_ocr(
                                buf.getvalue(), frame_idx, mime="image/jpeg"
                            )

                    pages_data = list(
                        await asyncio.gather(
                            *(process_tiff_frame(idx, f) for idx, f in enumerate(frames, start=1))
                        )
                    )
            except Exception as tiff_err:
                logger.error("Failed to process TIFF image frames: %s", tiff_err)
                raise OcrEmptyResultError(f"Failed to process TIFF image: {tiff_err}")

        # ── 4. Single Raster Image Routing (PNG, JPG, JPEG, WEBP) ─────────────
        else:
            total_p = 1
            with ocr_timer("render_ms", page=1, format="raster_direct"):
                pass
            res = await self._extract_page_with_tiered_ocr(
                file_bytes, 1, mime=mime_type or "image/png"
            )
            pages_data = [res]

        # ── 5. Progressive SSE Progress Notification in Sequential Order ───────
        if self.lifecycle:
            for p in pages_data:
                await self.lifecycle.report_progress(
                    job_id=job_id,
                    file_key=file_key,
                    stage=STAGE_OCR_RUNNING,
                    stage_status=STATUS_IN_PROGRESS,
                    previous_percentage=current_pct,
                    message=f"Extracting page {p['page']} of {total_p}",
                    completed_stages=completed_stages,
                    checkpoint_data=checkpoint_data,
                    page=p["page"],
                    total_pages=total_p,
                )

        # ── 6. Full Text Assembly with Downstream Failure Markers ─────────────
        with ocr_timer("postprocess_ms", scope="document_assembly"):
            text_parts: list[str] = []
            for p in pages_data:
                if p.get("status") == "FAILED" or not p.get("text"):
                    text_parts.append(f"[PAGE {p['page']} OCR FAILED - CLINICAL DATA UNREADABLE]")
                else:
                    text_parts.append(p["text"])

            full_text = "\n\n".join(part for part in text_parts if part).strip()
            elapsed_ms = int((time.monotonic() - t0) * 1000)

            used_direct = any(p.get("engine") in {"pymupdf_direct", "office_direct"} for p in pages_data)
            used_paddle = any(p.get("engine") in {"paddleocr", "hybrid_paddle_vlm"} for p in pages_data)
            used_qwen = any(p.get("engine") in {"qwen_vl", "hybrid_paddle_vlm"} for p in pages_data)
            used_ocr = used_paddle or used_qwen
            fallback_count = sum(1 for p in pages_data if p.get("status") == "FALLBACK")
            failed_count = sum(1 for p in pages_data if p.get("status") == "FAILED")

            confidences = [p["confidence"] for p in pages_data if p.get("confidence") is not None]
            mean_conf = round(sum(confidences) / len(confidences), 4) if confidences else (0.95 if full_text else 0.5)

            cache_hits = sum(1 for p in pages_data if p.get("cached") is True)
            cache_misses = sum(1 for p in pages_data if p.get("cached") is not True)

            from app.modules.ocr.script_detector import detect_scripts_in_text

            script_info = detect_scripts_in_text(full_text)
            detected_langs: list[str] = []
            for s in script_info.get("detected_scripts", []):
                if s == "latin":
                    detected_langs.append("english")
                elif s in {"devanagari", "gujarati", "tamil", "telugu", "kannada", "malayalam", "bengali"}:
                    detected_langs.append(s)
            if not detected_langs:
                detected_langs = ["english"]

            direct_text_count = sum(1 for p in pages_data if p.get("engine") in {"pymupdf_direct", "office_direct"})
            raster_ocr_count = sum(1 for p in pages_data if p.get("engine") not in {"pymupdf_direct", "office_direct"})
            hybrid_extraction = bool(direct_text_count > 0 and raster_ocr_count > 0)

        return {
            "pages": pages_data,
            "fullText": full_text,
            "text": full_text,
            "confidence": mean_conf,
            "pageCount": total_p,
            "processedPageCount": total_p,
            "detectedLanguages": detected_langs,
            "metrics": {
                "used_direct_text": used_direct,
                "used_ocr": used_ocr,
                "used_paddle_ocr": used_paddle,
                "used_qwen_vl": used_qwen,
                "used_ai_model": used_qwen,
                "direct_text_page_count": direct_text_count,
                "raster_ocr_page_count": raster_ocr_count,
                "per_page_routing_decisions": routing_decisions if is_pdf else [
                    {
                        "page": p.get("page", idx),
                        "decision": "pymupdf_direct" if p.get("engine") in {"pymupdf_direct", "office_direct"} else "raster_ocr",
                        "reason": None if p.get("engine") in {"pymupdf_direct", "office_direct"} else "NON_PDF_IMAGE",
                    }
                    for idx, p in enumerate(pages_data, start=1)
                ],
                "hybrid_extraction": hybrid_extraction,
                "detected_scripts": script_info.get("detected_scripts", []),
                "has_non_latin": script_info.get("has_non_latin", False),
                "cache_hits": cache_hits,
                "cache_misses": cache_misses,
                "fallback_count": fallback_count,
                "failed_page_count": failed_count,
                "page_count": total_p,
                "processing_seconds": round(elapsed_ms / 1000.0, 3),
                "elapsed_ms": elapsed_ms,
                "telemetry": [p.get("telemetry") for p in pages_data if p.get("telemetry")],
            },
        }
