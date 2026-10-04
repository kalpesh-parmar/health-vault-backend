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
from app.settings import Settings

logger = logging.getLogger(__name__)


@contextlib.contextmanager
def ocr_timer(step_name: str, **extra: Any):
    """Context-manager timer for attributing OCR stage execution sub-steps."""
    t_start = time.perf_counter()
    result = {"elapsed_ms": 0.0}
    try:
        yield result
    finally:
        result["elapsed_ms"] = round((time.perf_counter() - t_start) * 1000, 2)
        extra_str = f" ({', '.join(f'{k}={v}' for k, v in extra.items())})" if extra else ""
        logger.info("%s: %.2f ms%s", step_name, result["elapsed_ms"], extra_str)

def _compute_stage_summary(pages_data: list[dict[str, Any]]) -> dict[str, dict[str, float]]:
    """Aggregate per-stage timings across all pages into p50, p95, min, max, mean, sum."""
    timing_keys = [
        "queue_wait_ms",
        "render_ms",
        "preprocess_ms",
        "lang_detect_ms",
        "engine_init_ms",
        "det_ms",
        "rec_ms",
        "ocr_infer_ms",
        "quality_gate_ms",
        "vlm_call_ms",
        "vlm_crop_ms",
        "postprocess_ms",
        "total_page_ms",
    ]
    summary: dict[str, dict[str, float]] = {}
    for k in timing_keys:
        vals = [float(p.get("stage_timings", {}).get(k, 0.0)) for p in pages_data if p.get("stage_timings")]
        if vals:
            sorted_vals = sorted(vals)
            n = len(sorted_vals)
            p50_idx = int(0.50 * (n - 1))
            p95_idx = int(0.95 * (n - 1))
            summary[k] = {
                "min": round(min(vals), 2),
                "max": round(max(vals), 2),
                "mean": round(sum(vals) / n, 2),
                "p50": round(sorted_vals[p50_idx], 2),
                "p95": round(sorted_vals[p95_idx], 2),
                "sum": round(sum(vals), 2),
            }
        else:
            summary[k] = {"min": 0.0, "max": 0.0, "mean": 0.0, "p50": 0.0, "p95": 0.0, "sum": 0.0}
    return summary


def _render_single_pdf_page(doc_bytes: bytes, page_idx: int) -> tuple[bytes, str]:
    """Thread-safe rendering of a single PDF page to image bytes."""
    t0 = time.perf_counter()
    with fitz.open(stream=doc_bytes, filetype="pdf") as pdoc:
        page = pdoc.load_page(page_idx)
        rect = page.rect
        images_info = []
        for img in page.get_images():
            try:
                base_img = pdoc.extract_image(img[0])
                images_info.append({
                    "xref": img[0],
                    "width": base_img.get("width"),
                    "height": base_img.get("height"),
                    "ext": base_img.get("ext"),
                    "size_bytes": len(base_img.get("image", b"")),
                })
            except Exception:
                pass
        pix = page.get_pixmap(dpi=150, alpha=False)
        w, h = pix.width, pix.height
        try:
            out_bytes = pix.tobytes("jpeg", jpg_quality=88)
            mime = "image/jpeg"
        except Exception:
            out_bytes = pix.tobytes("png")
            mime = "image/png"
    dur_ms = (time.perf_counter() - t0) * 1000
    is_full_page_single = (len(images_info) == 1)
    logger.info(
        "[TIMING_EVIDENCE] render_cost_page_%d: rect=%s, embedded_images_count=%d, is_single_full_page=%s, embedded_dims=%s, dpi=150, scale=%.2f, final_pixels=%dx%d (%.2f MP), out_bytes=%d, render_ms=%.2fms",
        page_idx + 1,
        rect,
        len(images_info),
        is_full_page_single,
        [(img["width"], img["height"], img["size_bytes"]) for img in images_info],
        150 / 72.0,
        w,
        h,
        (w * h) / 1000000.0,
        len(out_bytes),
        dur_ms,
    )
    return out_bytes, mime


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
        settings: Settings | None = None,
    ) -> None:
        self.s3_client = s3_client
        self.lifecycle = lifecycle
        self.vision = vision_service
        self.paddle = paddle_engine
        self.settings = settings or Settings()
        self.quality_gate = quality_gate or QualityGate(
            max_fragment_ratio=self.settings.QUALITY_GATE_MAX_FRAGMENT_RATIO,
            min_avg_token_len=self.settings.QUALITY_GATE_MIN_AVG_TOKEN_LEN,
            min_valid_token_ratio=self.settings.QUALITY_GATE_MIN_VALID_TOKEN_RATIO,
            borderline_min_conf=self.settings.QUALITY_GATE_BORDERLINE_MIN_CONF,
            borderline_max_conf=self.settings.QUALITY_GATE_BORDERLINE_MAX_CONF,
        )
        self.min_direct_text_chars = min_direct_text_chars
        self.cache = cache

    async def _extract_paddle_safe(self, img_bytes: bytes, lang: str | None = None) -> dict[str, Any]:
        """Invoke paddle engine async extraction safely handling older/test mocks that do not accept lang keyword."""
        if not self.paddle:
            return {}
        try:
            return await self.paddle.async_extract_text_from_bytes(img_bytes, lang=lang)
        except TypeError as te:
            if "unexpected keyword argument 'lang'" in str(te) or ("unexpected keyword argument" in str(te) and "lang" in str(te)):
                return await self.paddle.async_extract_text_from_bytes(img_bytes)
            raise

    @staticmethod
    def _has_target_script_chars(text: str, lang: str) -> bool:
        """Check if recognized text contains characters belonging to the target Indic script."""
        if not text:
            return False
        if lang == "devanagari":
            return any(0x0900 <= ord(c) <= 0x097F for c in text)
        if lang == "ta":
            return any(0x0B80 <= ord(c) <= 0x0BFF for c in text)
        return True

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
        t_val_start = time.perf_counter()
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
        t_probe_start = time.perf_counter()
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
        probe_ms = (time.perf_counter() - t_probe_start) * 1000

        # Check for pure non-medical patterns
        t_regex_start = time.perf_counter()
        check_text = (sample_text + " " + filename).lower()
        has_medical = any(re.search(pat, check_text, re.IGNORECASE) for pat in MEDICAL_INDICATORS)
        is_non_medical = any(re.search(pat, check_text, re.IGNORECASE) for pat in NON_MEDICAL_PATTERNS)
        regex_ms = (time.perf_counter() - t_regex_start) * 1000

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
        val_total_ms = (time.perf_counter() - t_val_start) * 1000
        logger.info(
            "[TIMING_EVIDENCE] validate_document: probe_ms=%.2fms, regex_ms=%.2fms, total_val_ms=%.2fms, sample_chars=%d, has_medical=%s, is_non_medical=%s, failOpenUsed=%s (reason: %s)",
            probe_ms, regex_ms, val_total_ms, len(sample_text), has_medical, is_non_medical, validation_result["failOpenUsed"],
            "Scanned PDF with 0 direct text on page 0 and no medical keyword in filename, triggered HF-3 fail-open" if validation_result["failOpenUsed"] else "Medical indicator matched"
        )
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
        t_vu_start = time.perf_counter()
        logger.info("Verifying upload storage pointer: s3://%s/%s", bucket, key)
        temp_path = await self.s3_client.download_to_temp_file(
            bucket=bucket,
            key=key,
            expected_sha256=expected_sha256,
        )
        vu_ms = (time.perf_counter() - t_vu_start) * 1000
        if not temp_path.exists() or temp_path.stat().st_size == 0:
            raise CorruptFileException(f"Downloaded file is empty or missing: {temp_path}")
        logger.info(
            "[TIMING_EVIDENCE] verify_upload: total=%.2fms (file_size=%d bytes, path=%s)",
            vu_ms, temp_path.stat().st_size, temp_path.name
        )
        return temp_path

    @staticmethod
    def _is_pseudo_latin_noise(line_dict: dict[str, Any]) -> bool:
        """Identify garbled pseudo-Latin hallucinations emitted by English Paddle on non-Latin scripts."""
        text = str(line_dict.get("text", "")).strip()
        if not text:
            return True
        conf = float(line_dict.get("confidence") or 0.0)
        if conf < 0.60:
            return True

        from app.modules.ocr.script_detector import detect_scripts_in_text
        # If the line already contains actual non-Latin characters, it is NOT pseudo-Latin noise
        if detect_scripts_in_text(text).get("has_non_latin"):
            return False

        # Specific known hallucinated fragments from English Paddle on Indic glyphs
        if any(k in text for k in ["Eqy", "qyu", "o 1 a n d e r", "A l l r e g", "xzk", "cjv"]):
            return True

        # Check for spaced-out single-letter sequences (e.g. "o 1 a n d e r", "a b c d", "3 4 a t a r")
        tokens = text.split()
        if len(tokens) >= 3:
            single_char_tokens = [t for t in tokens if len(t) == 1]
            if len(single_char_tokens) / len(tokens) >= 0.50:
                return True

        # Check symbol/non-alphanumeric noise ratio
        alnum_chars = sum(1 for c in text if c.isalnum())
        if len(text) > 0 and (alnum_chars / len(text)) < 0.35:
            return True

        # If text consists only of Latin letters, check valid English/clinical words
        alpha_words = re.findall(r"[a-zA-Z]+", text)
        if len(alpha_words) >= 2:
            from app.modules.ocr.quality_gate import CLINICAL_LEXICON
            common_en = frozenset({
                "the", "is", "of", "and", "to", "in", "for", "on", "by", "at", "with",
                "from", "as", "no", "yes", "age", "sex", "dr", "mr", "mrs", "ms",
                "date", "name", "patient", "lab", "test", "report", "hospital", "clinic",
                "mg", "ml", "dl", "mm", "g", "kg", "normal", "high", "low", "result",
                "ref", "unit", "range", "male", "female", "years", "yrs", "time",
            })
            has_valid = any(w.lower() in CLINICAL_LEXICON or w.lower() in common_en for w in alpha_words)
            has_digits = any(c.isdigit() for c in text)
            if not has_valid and not has_digits:
                # All words are non-dictionary Latin clusters
                return True

        return False

    @staticmethod
    def _normalize_line_for_dedup(text: str) -> str:
        """Strip punctuation and whitespace for fuzzy/exact deduplication."""
        return re.sub(r"[^\w\d]+", "", text.lower())

    @classmethod
    def _deduplicate_lines(
        cls,
        base_lines: list[dict[str, Any]],
        incoming_lines: list[dict[str, Any]],
        similarity_threshold: float = 0.80,
    ) -> list[dict[str, Any]]:
        """Deduplicate lines between retained OCR and incoming VLM transcription."""
        import difflib

        result = list(base_lines)
        seen_normalized: dict[str, int] = {}
        for idx, l in enumerate(result):
            norm = cls._normalize_line_for_dedup(str(l.get("text", "")))
            if norm:
                seen_normalized[norm] = idx

        for inc in incoming_lines:
            inc_text = str(inc.get("text", "")).strip()
            norm = cls._normalize_line_for_dedup(inc_text)
            if not norm:
                continue

            if norm in seen_normalized:
                existing_idx = seen_normalized[norm]
                if float(inc.get("confidence") or 0.0) > float(result[existing_idx].get("confidence") or 0.0):
                    result[existing_idx] = inc
            else:
                is_dup = False
                for idx, existing in enumerate(result):
                    ex_norm = cls._normalize_line_for_dedup(str(existing.get("text", "")))
                    if not ex_norm:
                        continue
                    sim = difflib.SequenceMatcher(None, norm, ex_norm).ratio()
                    if sim >= similarity_threshold:
                        is_dup = True
                        if float(inc.get("confidence") or 0.0) > float(existing.get("confidence") or 0.0):
                            result[idx] = inc
                            seen_normalized[norm] = idx
                        break
                if not is_dup:
                    result.append(inc)
                    seen_normalized[norm] = len(result) - 1

        return result

    @staticmethod
    def _extract_bbox_coords(box: Any) -> tuple[float, float, float, float] | None:
        """Extract (min_x, min_y, max_x, max_y) from a 4-point polygon or 4-element box."""
        if not box:
            return None
        if isinstance(box, (list, tuple)):
            if len(box) >= 4 and isinstance(box[0], (list, tuple)) and len(box[0]) >= 2:
                try:
                    xs = [float(pt[0]) for pt in box if len(pt) >= 2]
                    ys = [float(pt[1]) for pt in box if len(pt) >= 2]
                    if xs and ys:
                        return min(xs), min(ys), max(xs), max(ys)
                except (ValueError, TypeError):
                    return None
            elif len(box) == 4 and all(isinstance(x, (int, float)) for x in box):
                return float(box[0]), float(box[1]), float(box[2]), float(box[3])
        return None

    @classmethod
    def _compute_failing_bboxes_union(
        cls,
        lines: list[dict[str, Any]],
        image_dims: tuple[int, int],
        max_failing_lines: int = 5,
        max_area_ratio: float = 0.35,
        min_line_confidence: float = 0.70,
    ) -> tuple[tuple[int, int, int, int], list[int]] | None:
        """Identify localized failing lines and compute their union bounding box with padding margin."""
        if not lines or not image_dims or image_dims[0] <= 0 or image_dims[1] <= 0:
            return None

        img_w, img_h = image_dims
        page_area = img_w * img_h
        failing_indices: list[int] = []
        failing_boxes: list[tuple[float, float, float, float]] = []

        for idx, line in enumerate(lines):
            conf = float(line.get("confidence") or 0.0)
            is_noise = cls._is_pseudo_latin_noise(line)
            if conf < min_line_confidence or is_noise:
                bbox = cls._extract_bbox_coords(line.get("box"))
                if bbox is not None:
                    failing_indices.append(idx)
                    failing_boxes.append(bbox)

        if not failing_indices or len(failing_indices) > max_failing_lines:
            return None
        if len(failing_indices) == len(lines):
            return None

        min_x = min(b[0] for b in failing_boxes)
        min_y = min(b[1] for b in failing_boxes)
        max_x = max(b[2] for b in failing_boxes)
        max_y = max(b[3] for b in failing_boxes)

        crop_w = max_x - min_x
        crop_h = max_y - min_y
        crop_area = crop_w * crop_h
        if crop_area > (max_area_ratio * page_area):
            return None

        margin = 20
        pad_x0 = max(0, int(min_x - margin))
        pad_y0 = max(0, int(min_y - margin))
        pad_x1 = min(img_w, int(max_x + margin))
        pad_y1 = min(img_h, int(max_y + margin))

        if pad_x1 <= pad_x0 or pad_y1 <= pad_y0:
            return None

        return (pad_x0, pad_y0, pad_x1, pad_y1), failing_indices

    async def _extract_crop_with_vlm(
        self,
        img_bytes: bytes,
        crop_box: tuple[int, int, int, int],
        mime: str = "image/jpeg",
        expected_script: str | None = None,
    ) -> list[dict[str, Any]]:
        """Crop the bounding box slice, transcribe with VLM, and tag with fallback provenance."""
        if not self.vision:
            return []

        x0, y0, x1, y1 = crop_box
        try:
            with Image.open(io.BytesIO(img_bytes)) as pil_img:
                crop_img = pil_img.crop((x0, y0, x1, y1))
                crop_buf = io.BytesIO()
                crop_img.save(crop_buf, format="JPEG", quality=90)
                crop_bytes = crop_buf.getvalue()
        except Exception as crop_err:
            logger.warning("Failed to slice image crop: %s", crop_err)
            return []

        crop_prompt = (
            "Transcribe all printed or handwritten text in this small image crop exactly as written line by line. "
            "Do not add any explanation or preamble."
        )
        try:
            res = await self.vision.extract_image(
                crop_bytes,
                filename="crop_slice.jpg",
                mime_type="image/jpeg",
                prompt=crop_prompt,
                max_pages=1,
            )
        except Exception as v_err:
            logger.warning("VLM crop extraction failed: %s", v_err)
            return []

        raw_crop_text = (res.get("text") or "").strip()
        if not raw_crop_text:
            return []

        from app.modules.ocr.fallback_validator import FallbackOutputValidator
        val = FallbackOutputValidator()
        val_res = val.validate(
            raw_crop_text,
            finish_reason=res.get("finish_reason"),
            expected_script=expected_script,
        )
        if not val_res.is_valid:
            logger.warning("VLM crop output rejected by validator: %s", val_res.reason)
            return []

        vision_conf = float(res.get("confidence") or 0.95)
        crop_lines: list[dict[str, Any]] = []
        for line in raw_crop_text.splitlines():
            line_str = line.strip()
            if line_str and not self._is_pseudo_latin_noise({"text": line_str, "confidence": vision_conf}):
                crop_lines.append({
                    "text": line_str,
                    "confidence": vision_conf,
                    "box": [[x0, y0], [x1, y0], [x1, y1], [x0, y1]],
                    "provenance": "vlm_fallback",
                })

        return crop_lines

    def _apply_vision_result(
        self,
        res: dict[str, Any],
        paddle_res: dict[str, Any] | None,
        fallback_reason: str | None,
        expected_script: str | None = None,
    ) -> tuple[str, float, list[dict[str, Any]], str, str]:
        """Process Vision model output and cleanly merge non-Latin lines with English Paddle lines."""
        from app.modules.ocr.script_detector import detect_scripts_in_text
        from app.modules.ocr.fallback_validator import FallbackOutputValidator

        raw_vision_text = (res.get("text") or "").strip()
        finish_reason = res.get("finish_reason")
        vision_conf = float(res.get("confidence") or 0.95) if raw_vision_text else 0.0

        # Validate VLM output against degenerate loops, empty responses, script collapse
        validator = FallbackOutputValidator()
        val_res = validator.validate(
            raw_vision_text,
            finish_reason=finish_reason,
            expected_script=expected_script,
        )

        if not val_res.is_valid:
            logger.warning(
                "VLM fallback output rejected by validator: reason=%s (loop='%s')",
                val_res.reason,
                val_res.detected_loop_snippet,
            )
            # If Paddle had some valid lines, retain them rather than returning degenerate text
            if paddle_res and paddle_res.get("lines"):
                retained_lines = [
                    dict(l) for l in paddle_res["lines"]
                    if float(l.get("confidence") or 0.0) >= 0.70 and not self._is_pseudo_latin_noise(l)
                ]
                if retained_lines:
                    page_text = "\n".join(l["text"] for l in retained_lines)
                    conf = round(sum(float(l.get("confidence") or 0.0) for l in retained_lines) / len(retained_lines), 4)
                    return page_text, conf, retained_lines, "paddleocr_partial", "FALLBACK_PARTIAL"
            return "", 0.0, [], "none", f"FAILED: {val_res.reason}"

        if fallback_reason and "UNREAD_NON_LATIN_SCRIPT" in fallback_reason and paddle_res and paddle_res.get("lines"):
            # Preserve accurate, high-confidence English lines from PaddleOCR, excising pseudo-Latin noise
            retained_lines = [
                dict(l) for l in paddle_res["lines"]
                if float(l.get("confidence") or 0.0) >= 0.70 and not self._is_pseudo_latin_noise(l)
            ]
            # Extract clean lines from Vision Model transcription tagged with fallback provenance
            incoming_lines = [
                {"text": l.strip(), "confidence": vision_conf, "provenance": "vlm_fallback"}
                for l in raw_vision_text.splitlines()
                if l.strip() and not self._is_pseudo_latin_noise({"text": l.strip(), "confidence": vision_conf})
            ]
            merged_lines = self._deduplicate_lines(retained_lines, incoming_lines)
            if merged_lines:
                page_text = "\n".join(l["text"] for l in merged_lines)
                conf = round(sum(float(l.get("confidence") or 0.95) for l in merged_lines) / len(merged_lines), 4)
                return page_text, conf, merged_lines, "hybrid_paddle_vlm", "FALLBACK"
            else:
                lines = [
                    {"text": l.strip(), "confidence": vision_conf, "provenance": "vlm_fallback"}
                    for l in raw_vision_text.splitlines()
                    if l.strip()
                ]
                return raw_vision_text, vision_conf, lines, "qwen_vl", "FALLBACK"
        else:
            lines = [
                {"text": l.strip(), "confidence": vision_conf, "provenance": "vlm_fallback"}
                for l in raw_vision_text.splitlines()
                if l.strip()
            ]
            status = "FALLBACK" if fallback_reason else "SUCCESS"
            return raw_vision_text, vision_conf, lines, "qwen_vl", status

    async def _extract_page_with_tiered_ocr(
        self,
        img_bytes: bytes,
        page_num: int,
        mime: str = "image/jpeg",
        render_ms: float = 0.0,
        queue_wait_ms: float = 0.0,
        text_hint: str = "",
        filename: str = "",
    ) -> dict[str, Any]:
        """Tiered extraction for a single rendered page or image:
        1. Pre-OCR Script Detection: inspect text hint; if non-Latin, skip Paddle directly to VLM.
        2. If script unknown: launch Paddle and VLM concurrently, cancelling loser.
        3. Evaluate via QualityGate.
        4. If Vision fails too, mark FAILED without aborting whole document.
        """
        page_start = time.perf_counter()
        page_text = ""
        confidence = 0.0
        lines: list[dict[str, Any]] = []
        engine_used = "none"
        status = "FAILED"
        fallback_reason = None
        error_msg = None
        page_telemetry: dict[str, Any] = {}

        stage_timings: dict[str, float] = {
            "queue_wait_ms": float(queue_wait_ms),
            "render_ms": float(render_ms),
            "preprocess_ms": 0.0,
            "lang_detect_ms": 0.0,
            "engine_init_ms": 0.0,
            "det_ms": 0.0,
            "rec_ms": 0.0,
            "ocr_infer_ms": 0.0,
            "quality_gate_ms": 0.0,
            "vlm_call_ms": 0.0,
            "vlm_crop_ms": 0.0,
            "postprocess_ms": 0.0,
            "total_page_ms": 0.0,
        }

        # ── Step 0: Preprocessing (Plan 3.2) ──
        preprocess_applied = False
        t_pre = time.perf_counter()
        with ocr_timer("preprocess_ms", page=page_num, bytes_len=len(img_bytes)):
            deskew_enabled = bool(getattr(self.settings, "preprocess_deskew_enabled", True))
            shadows_enabled = bool(getattr(self.settings, "preprocess_remove_shadows", False))
            if deskew_enabled or shadows_enabled:
                from app.services.pipeline.preprocessing import preprocess_document_image
                preprocessed_bytes = preprocess_document_image(
                    img_bytes,
                    deskew=deskew_enabled,
                    remove_shadows=shadows_enabled,
                )
                if preprocessed_bytes and len(preprocessed_bytes) > 0:
                    if preprocessed_bytes != img_bytes:
                        preprocess_applied = True
                        img_bytes = preprocessed_bytes
        stage_timings["preprocess_ms"] = round((time.perf_counter() - t_pre) * 1000, 2)
        page_telemetry["preprocess_applied"] = preprocess_applied
        page_telemetry["preprocess_ms"] = stage_timings["preprocess_ms"]

        # ── Step 0.5: Check SHA-256 Result Cache ──
        if self.cache is not None:
            config_hash = getattr(self.paddle, "config_hash", "") if self.paddle else ""
            cached_res = self.cache.get(img_bytes, engine_config_hash=config_hash)
            if cached_res is not None:
                cached_res["page"] = page_num
                if "stage_timings" not in cached_res:
                    cached_res["stage_timings"] = stage_timings
                if "telemetry" not in cached_res:
                    cached_res["telemetry"] = page_telemetry
                else:
                    cached_res["telemetry"]["preprocess_applied"] = preprocess_applied
                    cached_res["telemetry"]["preprocess_ms"] = stage_timings["preprocess_ms"]
                logger.info("Page %d OCR cache hit (SHA-256 key, elapsed_ms=%d)", page_num, cached_res.get("elapsed_ms", 0))
                return cached_res

        # ── Step 1: Script Detection Before OCR ──
        t_lang = time.perf_counter()
        target_lang = "en"
        is_non_latin_page = False
        detected_script = "latin"
        from app.modules.ocr.script_detector import detect_scripts_in_text

        script_detection_enabled = getattr(getattr(self, "settings", None), "ocr_script_detection_enabled", True)
        with ocr_timer("lang_detect_ms", page=page_num):
            if script_detection_enabled:
                if text_hint and text_hint.strip():
                    script_info = detect_scripts_in_text(text_hint)
                    if script_info.get("has_non_latin"):
                        detected_script = script_info.get("dominant_script") or "indic"
                elif filename:
                    from pathlib import Path
                    fn_stem = Path(filename).stem.lower()
                    if fn_stem.startswith(("hi_", "hi-", "hindi")) or "_hi_" in fn_stem or fn_stem.endswith("_hi"):
                        detected_script = "devanagari"
                    elif fn_stem.startswith(("mr_", "mr-", "marathi")) or "_mr_" in fn_stem or fn_stem.endswith("_mr"):
                        detected_script = "devanagari"
                    elif fn_stem.startswith(("ta_", "ta-", "tamil")) or "_ta_" in fn_stem or fn_stem.endswith("_ta"):
                        detected_script = "tamil"
                    elif fn_stem.startswith(("gu_", "gu-", "gujarati")) or "_gu_" in fn_stem or fn_stem.endswith("_gu"):
                        detected_script = "gujarati"

                if detected_script in ("devanagari", "hindi", "marathi"):
                    target_lang = "devanagari"
                    is_non_latin_page = False
                elif detected_script in ("tamil", "ta"):
                    target_lang = "ta"
                    is_non_latin_page = False
                elif detected_script in ("gujarati", "gu"):
                    is_non_latin_page = True
                    target_lang = detected_script
                else:
                    raw_lang = getattr(self.paddle, "lang", "en") if self.paddle else "en"
                    target_lang = raw_lang if isinstance(raw_lang, str) else "en"
                    is_non_latin_page = False

                if detected_script != "latin":
                    logger.info(
                        "Page %d pre-OCR script detection identified script: %s -> target_lang: %s (skip_paddle=%s)",
                        page_num, detected_script, target_lang, is_non_latin_page
                    )
            else:
                raw_lang = getattr(self.paddle, "lang", "en") if self.paddle else "en"
                target_lang = raw_lang if isinstance(raw_lang, str) else "en"
        stage_timings["lang_detect_ms"] = round((time.perf_counter() - t_lang) * 1000, 2)

        t_init = time.perf_counter()
        paddle_available = False
        with ocr_timer("model_load_ms", engine="paddleocr", page=page_num):
            paddle_available = bool(self.paddle and getattr(self.paddle, "is_available", lambda: True)())
            if not paddle_available:
                if self.paddle and getattr(self.paddle, "_init_error", None) is not None:
                    fallback_reason = f"primary_init_failed: {self.paddle._init_error}"
                elif not self.paddle:
                    fallback_reason = "primary_not_configured"
        stage_timings["engine_init_ms"] = round((time.perf_counter() - t_init) * 1000, 2)

        paddle_res = None
        concurrent_race_enabled = bool(
            getattr(getattr(self, "settings", None), "ocr_concurrent_race_enabled", True)
            and paddle_available
            and self.vision
            and not is_non_latin_page
        )

        if is_non_latin_page:
            # Skip PaddleOCR completely for unsupported non-Latin scripts (e.g. Gujarati) - preserve CPU cycles and route directly to VLM
            fallback_reason = f"UNREAD_NON_LATIN_SCRIPT_PRE_DETECTED_{detected_script.upper()}"
            logger.info("Page %d non-Latin script pre-detected (%s), skipping PaddleOCR directly to VLM", page_num, detected_script)
        elif concurrent_race_enabled:
            # ── Concurrent Race: Run PaddleOCR and VLM concurrently, cancel loser ──
            try:
                logger.info("Page %d launching concurrent race: PaddleOCR vs VLM", page_num)

                async def _paddle_runner() -> tuple[dict[str, Any] | None, float, Exception | None]:
                    t_inf = time.perf_counter()
                    timeout_sec = float(getattr(getattr(self, "settings", None), "paddle_timeout_seconds", 20.0))
                    logger.info(
                        "[TIMING_EVIDENCE] Page %d: _paddle_runner entered (timeout=%.1fs, bytes=%d, lang=%s)",
                        page_num, timeout_sec, len(img_bytes), target_lang
                    )
                    try:
                        p_res = await asyncio.wait_for(
                            self._extract_paddle_safe(img_bytes, lang=target_lang),
                            timeout=timeout_sec,
                        )
                        p_dur = round((time.perf_counter() - t_inf) * 1000, 2)
                        logger.info("[TIMING_EVIDENCE] Page %d: _paddle_runner completed in %.2fms", page_num, p_dur)
                        return p_res, p_dur, None
                    except asyncio.TimeoutError as te:
                        p_dur = round((time.perf_counter() - t_inf) * 1000, 2)
                        logger.warning(
                            "[TIMING_EVIDENCE] Page %d: PaddleOCR timed out! Elapsed=%.2fms (timer target was %.1fs, overrun=%.2fms)",
                            page_num, p_dur, timeout_sec, p_dur - (timeout_sec * 1000)
                        )
                        return None, p_dur, te
                    except Exception as pe:
                        p_dur = round((time.perf_counter() - t_inf) * 1000, 2)
                        logger.warning("[TIMING_EVIDENCE] Page %d: PaddleOCR exception after %.2fms: %s", page_num, p_dur, pe)
                        return None, p_dur, pe

                async def _vlm_runner() -> tuple[dict[str, Any] | None, float, Exception | None]:
                    t_vl = time.perf_counter()
                    try:
                        v_res = await self.vision.extract_image(
                            img_bytes,
                            filename=f"page_{page_num}.jpg",
                            mime_type=mime,
                            max_pages=1,
                        )
                        return v_res, round((time.perf_counter() - t_vl) * 1000, 2), None
                    except asyncio.CancelledError:
                        return None, round((time.perf_counter() - t_vl) * 1000, 2), None
                    except Exception as ve:
                        return None, round((time.perf_counter() - t_vl) * 1000, 2), ve

                p_task = asyncio.create_task(_paddle_runner())
                v_task = asyncio.create_task(_vlm_runner())

                done, pending = await asyncio.wait([p_task, v_task], return_when=asyncio.FIRST_COMPLETED)

                if p_task in done:
                    p_res, p_ms, p_err = p_task.result()
                    stage_timings["ocr_infer_ms"] = p_ms
                    paddle_res = p_res

                    if paddle_res and not p_err:
                        timings = paddle_res.get("timings") or {}
                        stage_timings["det_ms"] = float(timings.get("detector_ms", 0.0))
                        stage_timings["rec_ms"] = float(timings.get("recognizer_ms", 0.0))
                        if timings.get("engine_init_ms"):
                            stage_timings["engine_init_ms"] += float(timings.get("engine_init_ms", 0.0))
                        if timings.get("queue_wait_ms"):
                            stage_timings["queue_wait_ms"] += float(timings.get("queue_wait_ms", 0.0))

                        t_qg = time.perf_counter()
                        with ocr_timer("quality_gate_ms", engine="paddleocr", page=page_num):
                            gate_result = self.quality_gate.evaluate(paddle_res)
                        stage_timings["quality_gate_ms"] = round((time.perf_counter() - t_qg) * 1000, 2)

                        min_conf = getattr(getattr(self, "settings", None), "ocr_router_min_confidence", 0.82)
                        mean_c = float(paddle_res.get("mean_confidence") or 0.0)
                        low_conf_ratio = float(gate_result.details.get("low_confidence_line_ratio") or 0.0)
                        can_bypass_low_conf = (mean_c >= min_conf and low_conf_ratio <= 0.15)

                        if (gate_result.passed or can_bypass_low_conf) and not gate_result.has_unread_non_latin:
                            v_task.cancel()
                            logger.info(
                                "Page %d PaddleOCR won concurrent race (conf=%.2f, elapsed=%dms), cancelled VLM",
                                page_num,
                                mean_c,
                                p_ms,
                            )
                            page_text = paddle_res.get("full_text") or ""
                            confidence = mean_c or 0.95
                            lines = paddle_res.get("lines") or []
                            engine_used = f"paddleocr_{target_lang}" if target_lang != "en" else "paddleocr"
                            status = "SUCCESS"
                            fallback_reason = None
                        else:
                            fallback_reason = gate_result.reason
                            logger.info("Page %d PaddleOCR quality gate failed (%s)", page_num, fallback_reason)

                            # Check if this was an un-hinted page that might be an Indic document (Hindi, Marathi, Tamil)
                            is_indic_candidate = (
                                target_lang == "en"
                                and (
                                    gate_result.reason == "UNREAD_NON_LATIN_SCRIPT"
                                    or "LOW_VALID_TOKEN_RATIO" in str(gate_result.reason)
                                    or bool(gate_result.details.get("script_info", {}).get("has_potential_unread_non_latin"))
                                )
                            )
                            indic_recovered = False
                            if is_indic_candidate:
                                detected_scripts = gate_result.details.get("script_info", {}).get("detected_scripts", [])
                                retry_lang = "ta" if "tamil" in detected_scripts else "devanagari"
                                try:
                                    logger.info(
                                        "Page %d attempting concurrent race local CPU Indic recovery with lang=%s",
                                        page_num, retry_lang
                                    )
                                    t_retry = time.perf_counter()
                                    timeout_sec = float(getattr(self.settings, "paddle_timeout_seconds", 20.0))
                                    indic_res = await asyncio.wait_for(
                                        self._extract_paddle_safe(img_bytes, lang=retry_lang),
                                        timeout=timeout_sec,
                                    )
                                    if indic_res:
                                        indic_gate = self.quality_gate.evaluate(indic_res)
                                        target_chars_found = self._has_target_script_chars(indic_res.get("full_text") or "", retry_lang)
                                        if indic_gate.passed and not indic_gate.has_unread_non_latin and target_chars_found:
                                            v_task.cancel()
                                            paddle_res = indic_res
                                            gate_result = indic_gate
                                            page_text = indic_res.get("full_text") or ""
                                            confidence = float(indic_res.get("mean_confidence") or 0.95)
                                            lines = indic_res.get("lines") or []
                                            engine_used = f"paddleocr_{retry_lang}"
                                            status = "SUCCESS"
                                            fallback_reason = None
                                            indic_recovered = True
                                            stage_timings["indic_recovery_ms"] = round((time.perf_counter() - t_retry) * 1000, 2)
                                            logger.info(
                                                "Page %d Indic recovery succeeded with %s in %.2fms (conf=%.4f), cancelled VLM",
                                                page_num, retry_lang, stage_timings["indic_recovery_ms"], confidence
                                            )
                                except Exception as retry_err:
                                    logger.warning("Page %d Indic recovery attempt failed: %s", page_num, retry_err)

                            if not indic_recovered:
                                crop_info = None
                                try:
                                    with Image.open(io.BytesIO(img_bytes)) as pil_img:
                                        img_dims = pil_img.size
                                    crop_info = self._compute_failing_bboxes_union(paddle_res.get("lines") or [], img_dims)
                                except Exception:
                                    crop_info = None

                                if crop_info is not None:
                                    v_task.cancel()
                                    crop_box, failing_indices = crop_info
                                    logger.info(
                                        "Page %d attempting localized crop-only VLM fallback in concurrent race for %d lines (box=%s)",
                                        page_num, len(failing_indices), crop_box
                                    )
                                    t_crop = time.perf_counter()
                                    crop_lines = await self._extract_crop_with_vlm(
                                        img_bytes, crop_box, mime=mime, expected_script=detected_script
                                    )
                                    stage_timings["vlm_crop_ms"] = round((time.perf_counter() - t_crop) * 1000, 2)
                                    if crop_lines:
                                        failing_set = set(failing_indices)
                                        retained = [
                                            l for idx, l in enumerate(paddle_res.get("lines") or [])
                                            if idx not in failing_set and not self._is_pseudo_latin_noise(l)
                                        ]
                                        merged = self._deduplicate_lines(retained, crop_lines)
                                        if merged:
                                            page_text = "\n".join(l["text"] for l in merged)
                                            confidence = round(sum(float(l.get("confidence") or 0.95) for l in merged) / len(merged), 4)
                                            lines = merged
                                            engine_used = "hybrid_paddle_crop_vlm"
                                            status = "FALLBACK"
                                            fallback_reason = None
                                            logger.info(
                                                "Page %d localized crop VLM fallback succeeded in %.2fms (recovered %d lines, total=%d lines)",
                                                page_num, stage_timings["vlm_crop_ms"], len(crop_lines), len(lines)
                                            )

                                if status != "FALLBACK":
                                    logger.info("Page %d awaiting concurrent VLM (fallback_reason=%s)", page_num, fallback_reason)
                                    try:
                                        v_res, v_ms, v_err = await v_task
                                    except asyncio.CancelledError:
                                        v_res, v_ms, v_err = None, 0.0, None
                                    stage_timings["vlm_call_ms"] = v_ms
                                    if v_res and not v_err:
                                        page_telemetry = (v_res.get("metrics") or {}).get("telemetry") or {}
                                        page_text, confidence, lines, engine_used, status = self._apply_vision_result(
                                            v_res, paddle_res, fallback_reason, expected_script=detected_script
                                        )
                                else:
                                    try:
                                        await v_task
                                    except (asyncio.CancelledError, Exception):
                                        pass
                    else:
                        # Paddle errored or timed out; await VLM
                        timeout_sec = float(getattr(self.settings, "paddle_timeout_seconds", 20.0))
                        fb_reason = f"PADDLE_TIMEOUT_{timeout_sec}S" if isinstance(p_err, asyncio.TimeoutError) else "PADDLE_FAILED"
                        fallback_reason = fb_reason
                        logger.info("Page %d PaddleOCR failed/timed out (%s), awaiting concurrent VLM", page_num, fb_reason)
                        v_res, v_ms, v_err = await v_task
                        stage_timings["vlm_call_ms"] = v_ms
                        if v_res and not v_err:
                            page_telemetry = (v_res.get("metrics") or {}).get("telemetry") or {}
                            page_text, confidence, lines, engine_used, status = self._apply_vision_result(
                                v_res, None, fb_reason, expected_script=detected_script
                            )
                elif v_task in done:
                    v_res, v_ms, v_err = v_task.result()
                    stage_timings["vlm_call_ms"] = v_ms
                    v_text = (v_res.get("text") or "").strip() if v_res else ""
                    v_script = detect_scripts_in_text(v_text)
                    v_conf = float(v_res.get("confidence") or 0.95) if (v_res and v_text) else 0.0

                    if v_res and (v_script.get("has_non_latin") or v_conf >= 0.85):
                        p_task.cancel()
                        fb_reason = "UNREAD_NON_LATIN_SCRIPT" if v_script.get("has_non_latin") else None
                        logger.info(
                            "[TIMING_EVIDENCE] Page %d: VLM won concurrent race (non_latin=%s, elapsed=%dms), called p_task.cancel() on PaddleOCR task",
                            page_num,
                            v_script.get("has_non_latin"),
                            v_ms,
                        )
                        page_telemetry = (v_res.get("metrics") or {}).get("telemetry") or {}
                        page_text, confidence, lines, engine_used, status = self._apply_vision_result(
                            v_res, None, fb_reason, expected_script=detected_script
                        )
                        fallback_reason = fb_reason
                    else:
                        # VLM completed first but produced low confidence / empty text; await Paddle
                        p_err = None
                        try:
                            p_res, p_ms, p_err = await p_task
                            stage_timings["ocr_infer_ms"] = p_ms
                            paddle_res = p_res
                        except asyncio.CancelledError:
                            paddle_res = None
                        except Exception as pe:
                            p_err = pe
                            paddle_res = None

                        if paddle_res and not p_err:
                            gate_result = self.quality_gate.evaluate(paddle_res)
                            min_conf = getattr(self.settings, "ocr_router_min_confidence", 0.82)
                            mean_c = float(paddle_res.get("mean_confidence") or 0.0)
                            low_conf_ratio = float(gate_result.details.get("low_confidence_line_ratio") or 0.0)
                            can_bypass_low_conf = (mean_c >= min_conf and low_conf_ratio <= 0.15)
                            if (gate_result.passed or can_bypass_low_conf) and not gate_result.has_unread_non_latin:
                                page_text = paddle_res.get("full_text") or ""
                                confidence = mean_c or 0.95
                                lines = paddle_res.get("lines") or []
                                engine_used = f"paddleocr_{target_lang}" if target_lang != "en" else "paddleocr"
                                status = "SUCCESS"
                                fallback_reason = None
                            else:
                                if v_res:
                                    page_text, confidence, lines, engine_used, status = self._apply_vision_result(
                                        v_res, paddle_res, gate_result.reason, expected_script=detected_script
                                    )
                        elif v_res:
                            page_text, confidence, lines, engine_used, status = self._apply_vision_result(
                                v_res, None, "VLM_FALLBACK", expected_script=detected_script
                            )
            except Exception as race_err:
                fallback_reason = f"concurrent_race_error: {race_err}"
                logger.warning("Page %d concurrent race exception: %s", page_num, race_err)
        elif paddle_available:
            # ── Standard Sequential PaddleOCR ──
            timeout_sec = float(getattr(getattr(self, "settings", None), "paddle_timeout_seconds", 20.0))
            try:
                t_infer = time.perf_counter()
                with ocr_timer("ocr_infer_ms", engine="paddleocr", lang=target_lang, pass_num=1, page=page_num):
                    paddle_res = await asyncio.wait_for(
                        self._extract_paddle_safe(img_bytes, lang=target_lang),
                        timeout=timeout_sec,
                    )
                stage_timings["ocr_infer_ms"] = round((time.perf_counter() - t_infer) * 1000, 2)

                timings = paddle_res.get("timings") or {}
                stage_timings["det_ms"] = float(timings.get("detector_ms", 0.0))
                stage_timings["rec_ms"] = float(timings.get("recognizer_ms", 0.0))
                if timings.get("engine_init_ms"):
                    stage_timings["engine_init_ms"] += float(timings.get("engine_init_ms", 0.0))
                if timings.get("queue_wait_ms"):
                    stage_timings["queue_wait_ms"] += float(timings.get("queue_wait_ms", 0.0))

                t_qg = time.perf_counter()
                with ocr_timer("quality_gate_ms", engine="paddleocr", page=page_num):
                    gate_result = self.quality_gate.evaluate(paddle_res)
                stage_timings["quality_gate_ms"] = round((time.perf_counter() - t_qg) * 1000, 2)

                t_post = time.perf_counter()
                with ocr_timer("postprocess_ms", engine="paddleocr", page=page_num):
                    min_conf = getattr(getattr(self, "settings", None), "ocr_router_min_confidence", 0.82)
                    mean_c = float(paddle_res.get("mean_confidence") or 0.0)
                    low_conf_ratio = float(gate_result.details.get("low_confidence_line_ratio") or 0.0)

                    page_telemetry.update({
                        "get_instance_ms": timings.get("get_instance_ms", 0),
                        "engine_init_ms": timings.get("engine_init_ms", 0),
                        "image_decode_ms": timings.get("image_decode_ms", 0),
                        "detector_ms": timings.get("detector_ms", 0),
                        "recognizer_ms": timings.get("recognizer_ms", 0),
                        "result_conversion_ms": timings.get("result_conversion_ms", 0),
                        "total_ocr_ms": timings.get("total_ocr_ms", 0),
                        "queue_wait_ms": timings.get("queue_wait_ms", 0),
                        "worker_pid": paddle_res.get("worker_pid"),
                    })
                    logger.info(
                        "Page %d PaddleOCR timings: total=%d ms, det=%d ms, rec=%d ms, decode=%d ms, conv=%d ms, engine_init=%d ms, queue_wait=%d ms, pid=%s (lines=%d, conf=%.4f)",
                        page_num,
                        timings.get("total_ocr_ms", 0),
                        timings.get("detector_ms", 0),
                        timings.get("recognizer_ms", 0),
                        timings.get("image_decode_ms", 0),
                        timings.get("result_conversion_ms", 0),
                        timings.get("engine_init_ms", 0),
                        timings.get("queue_wait_ms", 0),
                        paddle_res.get("worker_pid"),
                        paddle_res.get("line_count", 0),
                        mean_c,
                    )

                    can_bypass_low_conf = (
                        mean_c >= min_conf
                        and low_conf_ratio <= 0.15
                    )
                    if (gate_result.passed or can_bypass_low_conf) and not gate_result.has_unread_non_latin:
                        page_text = paddle_res.get("full_text") or ""
                        confidence = mean_c or 0.95
                        lines = paddle_res.get("lines") or []
                        engine_used = f"paddleocr_{target_lang}" if target_lang != "en" else "paddleocr"
                        status = "SUCCESS"
                        fallback_reason = None
                    else:
                        fallback_reason = gate_result.reason
                        logger.info("Page %d PaddleOCR quality gate failed: %s", page_num, fallback_reason)

                        # Check if this was an un-hinted page that might be an Indic document (Hindi, Marathi, Tamil)
                        # Attempt local CPU Indic recovery before escalating to heavy VLM
                        is_indic_candidate = (
                            target_lang == "en"
                            and (
                                gate_result.reason == "UNREAD_NON_LATIN_SCRIPT"
                                or "LOW_VALID_TOKEN_RATIO" in str(gate_result.reason)
                                or bool(gate_result.details.get("script_info", {}).get("has_potential_unread_non_latin"))
                            )
                        )
                        if is_indic_candidate:
                            detected_scripts = gate_result.details.get("script_info", {}).get("detected_scripts", [])
                            retry_lang = "ta" if "tamil" in detected_scripts else "devanagari"
                            try:
                                logger.info(
                                    "Page %d attempting local CPU Indic recovery with lang=%s",
                                    page_num, retry_lang
                                )
                                t_retry = time.perf_counter()
                                indic_res = await asyncio.wait_for(
                                    self._extract_paddle_safe(img_bytes, lang=retry_lang),
                                    timeout=timeout_sec,
                                )
                                if indic_res:
                                    indic_gate = self.quality_gate.evaluate(indic_res)
                                    target_chars_found = self._has_target_script_chars(indic_res.get("full_text") or "", retry_lang)
                                    if indic_gate.passed and not indic_gate.has_unread_non_latin and target_chars_found:
                                        paddle_res = indic_res
                                        gate_result = indic_gate
                                        page_text = indic_res.get("full_text") or ""
                                        confidence = float(indic_res.get("mean_confidence") or 0.95)
                                        lines = indic_res.get("lines") or []
                                        engine_used = f"paddleocr_{retry_lang}"
                                        status = "SUCCESS"
                                        fallback_reason = None
                                        stage_timings["indic_recovery_ms"] = round((time.perf_counter() - t_retry) * 1000, 2)
                                        logger.info(
                                            "Page %d Indic recovery succeeded with %s in %.2fms (conf=%.4f)",
                                            page_num, retry_lang, stage_timings["indic_recovery_ms"], confidence
                                        )
                            except Exception as retry_err:
                                logger.warning("Page %d Indic recovery attempt failed: %s", page_num, retry_err)

                stage_timings["postprocess_ms"] = round((time.perf_counter() - t_post) * 1000, 2)
            except asyncio.TimeoutError:
                fallback_reason = f"PADDLE_TIMEOUT_{timeout_sec}S"
                stage_timings["ocr_infer_ms"] = round((time.perf_counter() - t_infer) * 1000, 2)
                logger.warning("Page %d PaddleOCR timed out after %.1fs, falling back to VLM", page_num, timeout_sec)
            except Exception as p_err:
                fallback_reason = f"PaddleOCR exception: {p_err}"
                logger.warning("Page %d PaddleOCR exception: %s", page_num, p_err)

        # ── Step 1.5: Attempt Localized Crop-Only VLM Fallback ──
        if status != "SUCCESS" and self.vision and paddle_res and paddle_res.get("lines"):
            try:
                with Image.open(io.BytesIO(img_bytes)) as pil_img:
                    img_dims = pil_img.size
                crop_info = self._compute_failing_bboxes_union(paddle_res["lines"], img_dims)
                if crop_info is not None:
                    crop_box, failing_indices = crop_info
                    logger.info(
                        "Page %d attempting localized crop-only VLM fallback for %d lines (box=%s)",
                        page_num, len(failing_indices), crop_box
                    )
                    t_crop = time.perf_counter()
                    crop_lines = await self._extract_crop_with_vlm(
                        img_bytes, crop_box, mime=mime, expected_script=detected_script
                    )
                    stage_timings["vlm_crop_ms"] = round((time.perf_counter() - t_crop) * 1000, 2)
                    if crop_lines:
                        failing_set = set(failing_indices)
                        retained = [
                            l for idx, l in enumerate(paddle_res["lines"])
                            if idx not in failing_set and not self._is_pseudo_latin_noise(l)
                        ]
                        merged = self._deduplicate_lines(retained, crop_lines)
                        if merged:
                            page_text = "\n".join(l["text"] for l in merged)
                            confidence = round(sum(float(l.get("confidence") or 0.95) for l in merged) / len(merged), 4)
                            lines = merged
                            engine_used = "hybrid_paddle_crop_vlm"
                            status = "FALLBACK"
                            fallback_reason = None
                            logger.info(
                                "Page %d localized crop VLM fallback succeeded in %.2fms (recovered %d lines, total=%d lines)",
                                page_num, stage_timings["vlm_crop_ms"], len(crop_lines), len(lines)
                            )
            except Exception as crop_err:
                logger.warning("Page %d crop VLM fallback attempt failed: %s", page_num, crop_err)

        # ── Step 2: Fallback to Full-Page Vision Model (Qwen3-VL) if needed ──
        if status != "SUCCESS" and engine_used != "hybrid_paddle_crop_vlm" and self.vision:
            try:
                logger.info(
                    "Routing page %d to Vision Model (fallback_reason=%s)",
                    page_num,
                    fallback_reason or "Primary engine not configured",
                )
                t_vlm = time.perf_counter()
                with ocr_timer("ocr_infer_ms", engine="qwen_vl", lang=target_lang, pass_num=2, page=page_num):
                    res = await self.vision.extract_image(
                        img_bytes,
                        filename=f"page_{page_num}.jpg",
                        mime_type=mime,
                        max_pages=1,
                    )
                    # Multi-Engine / Multi-Prompt Retry: empty output indicates prompt refusal or model stall
                    if not (res.get("text") or "").strip():
                        logger.info("Page %d VLM returned empty response; attempting direct transcription retry", page_num)
                        try:
                            retry_res = await self.vision.extract_image(
                                img_bytes,
                                filename=f"page_{page_num}.jpg",
                                mime_type=mime,
                                max_pages=1,
                                prompt="Extract and transcribe all printed and handwritten text in this medical document exactly as written line by line.",
                            )
                            if (retry_res.get("text") or "").strip():
                                res = retry_res
                        except Exception as retry_err:
                            logger.warning("Page %d VLM retry failed: %s", page_num, retry_err)

                stage_timings["vlm_call_ms"] = round((time.perf_counter() - t_vlm) * 1000, 2)
                page_telemetry = (res.get("metrics") or {}).get("telemetry") or {}
                t_post_vlm = time.perf_counter()
                with ocr_timer("postprocess_ms", engine="qwen_vl", page=page_num):
                    page_text, confidence, lines, engine_used, status = self._apply_vision_result(
                        res, paddle_res, fallback_reason, expected_script=detected_script
                    )
                stage_timings["postprocess_ms"] += round((time.perf_counter() - t_post_vlm) * 1000, 2)
            except Exception as v_err:
                error_msg = str(v_err)
                logger.warning("Vision OCR failed on page %d: %s", page_num, v_err)
                page_text = ""
                confidence = 0.0
                lines = []
                engine_used = "none"
                status = "FAILED"

        elapsed_page_ms = int(round((time.perf_counter() - page_start) * 1000))
        stage_timings["total_page_ms"] = float(elapsed_page_ms)
        page_telemetry["preprocess_applied"] = preprocess_applied
        page_telemetry["preprocess_ms"] = stage_timings["preprocess_ms"]
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
            "stage_timings": stage_timings,
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
                        "stage_timings": {
                            "queue_wait_ms": 0.0,
                            "render_ms": 0.0,
                            "preprocess_ms": 0.0,
                            "lang_detect_ms": 0.0,
                            "engine_init_ms": 0.0,
                            "det_ms": 0.0,
                            "rec_ms": 0.0,
                            "ocr_infer_ms": 0.0,
                            "quality_gate_ms": 0.0,
                            "vlm_call_ms": 0.0,
                            "postprocess_ms": float(elapsed_ms),
                            "total_page_ms": float(elapsed_ms),
                        },
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
                stage_summary = _compute_stage_summary(pages_data)
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
                        "stage_timings": {1: pages_data[0]["stage_timings"]},
                        "stage_summary": stage_summary,
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
                    raw_text_dict: dict[int, str] = {}

                    # Evaluate every page individually with validate_page_direct_text
                    for index in range(total_p):
                        page_num = index + 1
                        t_direct = time.perf_counter()
                        try:
                            raw_text = doc.load_page(index).get_text("text") or ""
                        except Exception as page_read_err:
                            logger.warning("Failed to read direct text on page %d: %s", page_num, page_read_err)
                            raw_text = ""
                        raw_text_dict[page_num] = raw_text

                        val_res = validate_page_direct_text(doc, page_number=page_num, text=raw_text)
                        direct_ms = round((time.perf_counter() - t_direct) * 1000, 2)
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
                                "elapsed_ms": int(direct_ms),
                                "engine": "pymupdf_direct",
                                "status": "SUCCESS",
                                "stage_timings": {
                                    "queue_wait_ms": 0.0,
                                    "render_ms": 0.0,
                                    "preprocess_ms": 0.0,
                                    "lang_detect_ms": 0.0,
                                    "engine_init_ms": 0.0,
                                    "det_ms": 0.0,
                                    "rec_ms": 0.0,
                                    "ocr_infer_ms": 0.0,
                                    "quality_gate_ms": 0.0,
                                    "vlm_call_ms": 0.0,
                                    "postprocess_ms": direct_ms,
                                    "total_page_ms": direct_ms,
                                },
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

                        stage_summary = _compute_stage_summary(pages_data)
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
                                "stage_timings": {p["page"]: p.get("stage_timings", {}) for p in pages_data},
                                "stage_summary": stage_summary,
                            },
                        }

                    # Mixed / Scanned PDF: Rasterize remaining pages needing OCR
                    scanned_page_nums = [p for p in range(1, total_p + 1) if p not in pages_data_dict]
                    if scanned_page_nums:
                        concurrency = int(getattr(self.settings, "paddle_max_workers", 4))
                        concurrency = max(1, min(concurrency, 8))
                        semaphore = asyncio.Semaphore(concurrency)
                        logger.info(
                            "Routing %d scanned / corrupted pages to raster OCR with concurrency=%d",
                            len(scanned_page_nums),
                            concurrency,
                        )

                        async def process_scanned_page(page_num: int) -> dict[str, Any]:
                            t_render = time.perf_counter()
                            try:
                                with ocr_timer("render_ms", page=page_num, format="pdf"):
                                    img_bytes, mime = await asyncio.to_thread(
                                        _render_single_pdf_page, file_bytes, page_num - 1
                                    )
                                render_ms = round((time.perf_counter() - t_render) * 1000, 2)
                            except Exception as render_err:
                                logger.warning("Render failed on page %d: %s", page_num, render_err)
                                return {
                                    "page": page_num,
                                    "text": "",
                                    "confidence": 0.0,
                                    "lines": [],
                                    "elapsed_ms": 0,
                                    "engine": "unknown",
                                    "status": "FAILED",
                                    "fallback_reason": f"render_error: {render_err}",
                                    "stage_timings": {},
                                }

                            t_wait = time.perf_counter()
                            logger.info(
                                "[TIMING_EVIDENCE] Page %d waiting to acquire raster OCR semaphore (concurrency=%d)",
                                page_num, concurrency
                            )
                            async with semaphore:
                                queue_wait_ms = round((time.perf_counter() - t_wait) * 1000, 2)
                                logger.info(
                                    "[TIMING_EVIDENCE] Page %d acquired raster OCR semaphore (waited %.2fms)",
                                    page_num, queue_wait_ms
                                )
                                text_hint = raw_text_dict.get(page_num, "")
                                return await self._extract_page_with_tiered_ocr(
                                    img_bytes,
                                    page_num,
                                    mime=mime,
                                    render_ms=render_ms,
                                    queue_wait_ms=queue_wait_ms,
                                    text_hint=text_hint,
                                    filename=filename,
                                )

                        stop_lag_monitor = asyncio.Event()

                        async def _lag_monitor():
                            while not stop_lag_monitor.is_set():
                                t_tick = time.perf_counter()
                                try:
                                    await asyncio.sleep(0.05)
                                except asyncio.CancelledError:
                                    break
                                lag = (time.perf_counter() - t_tick) - 0.05
                                if lag > 0.1:  # Event loop blocked for >100ms
                                    logger.warning(
                                        "[TIMING_EVIDENCE] EVENT_LOOP_BLOCKED: tick took %.3fs (lag=%.3fs)",
                                        lag + 0.05, lag
                                    )

                        lag_task = asyncio.create_task(_lag_monitor())
                        try:
                            scanned_results = await asyncio.gather(
                                *(process_scanned_page(p) for p in scanned_page_nums)
                            )
                        finally:
                            stop_lag_monitor.set()
                            lag_task.cancel()

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
                        t_wait = time.perf_counter()
                        async with semaphore:
                            queue_wait_ms = round((time.perf_counter() - t_wait) * 1000, 2)
                            t_render = time.perf_counter()
                            with ocr_timer("render_ms", page=frame_idx, format="tiff"):
                                buf = io.BytesIO()
                                frame_img.convert("RGB").save(buf, format="JPEG", quality=88)
                            render_ms = round((time.perf_counter() - t_render) * 1000, 2)
                            return await self._extract_page_with_tiered_ocr(
                                buf.getvalue(), frame_idx, mime="image/jpeg", render_ms=render_ms, queue_wait_ms=queue_wait_ms, filename=filename
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
                file_bytes, 1, mime=mime_type or "image/png", render_ms=0.0, queue_wait_ms=0.0, filename=filename
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
            used_paddle = any(p.get("engine", "").startswith("paddleocr") or p.get("engine") == "hybrid_paddle_vlm" for p in pages_data)
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

        stage_summary = _compute_stage_summary(pages_data)
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
                "stage_timings": {p["page"]: p.get("stage_timings", {}) for p in pages_data},
                "stage_summary": stage_summary,
            },
        }
