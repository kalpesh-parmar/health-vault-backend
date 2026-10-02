from __future__ import annotations

import io
import hashlib
import json
import logging
import re
import asyncio
import threading
import time
from collections import OrderedDict
from typing import Any
from PIL import Image

# Safely pre-load PyTorch native DLLs before Paddle/PaddleOCR load OpenMP on Windows
try:
    import torch  # noqa: F401
except Exception:
    pass

from app.core.errors import ModelUnavailableError, OcrEmptyResultError
from app.core.json_utils import parse_json_object
from app.modules.ocr.cleanup import clean_ocr_text
from app.services.ai_client import AiClient, AiClientConfig, build_ai_client

logger = logging.getLogger(__name__)

# --- GLOBAL PADDLEOCR INITIALIZATION ---
import sys
import os
import cv2
import numpy as np

# Redundant global_ocr eliminated in Phase P2 (ProcessPoolExecutor managed by PaddleOcrEngine)
# ---------------------------------------

_JSON_FENCE = re.compile(r"```(?:json)?|```", re.IGNORECASE)

_OCR_PROMPT = (
    "You are an accurate OCR engine for medical documents. "
    "Transcribe ALL visible text exactly as it appears in this document image into clean markdown/plain text. "
    "Preserve line breaks, exact numbers, test names, values, units, reference intervals, dates, and tabular column alignments. "
    "Do not summarize, interpret, translate, or omit any text. "
    "Output ONLY the transcribed document text."
)


def downscale_image_if_needed(
    image_bytes: bytes,
    max_side: int = 1500,
) -> tuple[bytes, dict[str, Any]]:
    """
    Proportionally downscale images exceeding max_side on their longest dimension.
    If image longest dimension <= max_side, return untouched bytes.
    Returns: (output_bytes, downscale_info_dict)
    """
    if not image_bytes or max_side <= 0:
        return image_bytes, {
            "downscaled": False,
            "original_dims": None,
            "scaled_dims": None,
            "bytes_saved_pct": 0.0,
        }

    try:
        with Image.open(io.BytesIO(image_bytes)) as img:
            orig_w, orig_h = img.size
            longest_side = max(orig_w, orig_h)
            if longest_side <= max_side:
                return image_bytes, {
                    "downscaled": False,
                    "original_dims": (orig_w, orig_h),
                    "scaled_dims": (orig_w, orig_h),
                    "bytes_saved_pct": 0.0,
                }

            scale = max_side / float(longest_side)
            new_w = max(1, int(round(orig_w * scale)))
            new_h = max(1, int(round(orig_h * scale)))

            if img.mode in ("RGBA", "LA", "P"):
                rgb_img = Image.new("RGB", (orig_w, orig_h), (255, 255, 255))
                if img.mode == "P":
                    rgb_img.paste(img.convert("RGBA"))
                else:
                    rgb_img.paste(img, mask=img.split()[-1])
                img_to_resize = rgb_img
            elif img.mode != "RGB":
                img_to_resize = img.convert("RGB")
            else:
                img_to_resize = img

            resized = img_to_resize.resize((new_w, new_h), Image.Resampling.LANCZOS)
            out_buf = io.BytesIO()
            resized.save(out_buf, format="JPEG", quality=88, optimize=True)
            new_bytes = out_buf.getvalue()

            orig_len = len(image_bytes)
            new_len = len(new_bytes)
            saved_pct = round(((orig_len - new_len) / orig_len) * 100, 2) if orig_len > 0 else 0.0

            return new_bytes, {
                "downscaled": True,
                "original_dims": (orig_w, orig_h),
                "scaled_dims": (new_w, new_h),
                "bytes_saved_pct": saved_pct,
            }
    except Exception as exc:
        logger.warning("Failed to inspect/downscale image, using original bytes: %s", exc)
        return image_bytes, {
            "downscaled": False,
            "original_dims": None,
            "scaled_dims": None,
            "bytes_saved_pct": 0.0,
            "error": str(exc),
        }



class VisionModelRequestError(ModelUnavailableError):
    def __init__(self, message: str, *, classification: str = "error") -> None:
        super().__init__(message)
        self.classification = classification


class VisionModelOutputError(OcrEmptyResultError):
    code = "ai_model_invalid_output"


def empty_medical_extraction() -> dict[str, Any]:
    return {
        "patientInfo": {},
        "hospitalInfo": {},
        "doctorInfo": {},
        "diagnosis": [],
        "medications": [],
        "labResults": [],
        "vitals": [],
        "recommendations": [],
        "summary": "",
    }


def empty_summary(*, document_type: str = "medical") -> dict[str, Any]:
    return {
        "type": document_type,
        "mode": "concise",
        "summary": [],
        "medications": [],
        "tests": [],
        "warnings": [],
        "follow_up": [],
    }


class _ResultCache:
    def __init__(self, max_entries: int) -> None:
        self._max = max(0, int(max_entries))
        self._store: "OrderedDict[str, dict]" = OrderedDict()
        self._lock = threading.Lock()

    def get(self, key: str) -> dict | None:
        if self._max == 0:
            return None
        with self._lock:
            value = self._store.get(key)
            if value is not None:
                self._store.move_to_end(key)
            return value

    def put(self, key: str, value: dict) -> None:
        if self._max == 0:
            return
        with self._lock:
            self._store[key] = value
            self._store.move_to_end(key)
            while len(self._store) > self._max:
                self._store.popitem(last=False)


class VisionModelService:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        model: str,
        timeout_seconds: float,
        max_retries: int,
        max_output_tokens: int,
        min_text_chars: int,
        cache_size: int,
        max_inline_bytes: int,
        page_concurrency: int = 4,
        max_image_side: int = 1500,
        num_ctx: int = 4096,
        num_predict: int = 1536,
    ) -> None:
        self.api_key = (api_key or "").strip()
        self.base_url = (base_url or "").rstrip("/")
        self.model = (model or "").strip()
        self.timeout_seconds = float(timeout_seconds)
        self.max_retries = int(max_retries)
        self.max_output_tokens = int(max_output_tokens)
        self.min_text_chars = max(1, int(min_text_chars))
        self.max_inline_bytes = int(max_inline_bytes)
        self.page_concurrency = max(1, int(page_concurrency))
        self.max_image_side = int(max_image_side)
        self.num_ctx = int(num_ctx)
        self.num_predict = int(num_predict)
        self._cache = _ResultCache(cache_size)
        self._client: AiClient | None = None
        self._available: bool | None = None

        if not self.base_url:
            raise VisionModelRequestError("AI_BASE_URL is required")
        if not self.model:
            raise VisionModelRequestError("AI_MODEL is required")

    def _ensure_client(self) -> AiClient:
        if self._client is None:
            self._client = build_ai_client(
                AiClientConfig(
                    api_key=self.api_key,
                    base_url=self.base_url,
                    model=self.model,
                    timeout_seconds=self.timeout_seconds,
                    max_retries=self.max_retries,
                    max_output_tokens=self.max_output_tokens,
                    num_ctx=self.num_ctx,
                    num_predict=self.num_predict,
                )
            )
        return self._client

    async def warm_up(self) -> None:
        await self._ensure_client().validate_model_available()
        self._available = True
        logger.info("ai_client_ready", extra={"engine": self._ensure_client().engine, "model": self.model})

    async def close(self) -> None:
        if self._client is not None:
            await self._client.close()

    def status(self) -> dict[str, Any]:
        return {
            "engine": self._ensure_client().engine,
            "model": self.model,
            "available": self._available,
        }

    async def extract_pdf(
        self,
        pdf_bytes: bytes,
        *,
        max_pages: int = 25,
        **kwargs: Any,
    ) -> dict[str, Any]:
        del kwargs
        if not pdf_bytes:
            raise VisionModelRequestError("Empty PDF payload received")

        # Native Google endpoints accept PDF bytes. OpenAI-compatible local
        # servers such as Ollama generally expect raster image inputs for
        # vision models. For chat-completions engines, render PDF pages to PNG
        # first and OCR each page image.
        client = self._ensure_client()
        if client.engine == "google-genai":
            return await self._extract(pdf_bytes, mime_type="application/pdf")

        page_images = await asyncio.to_thread(_render_pdf_pages_to_png, pdf_bytes, max_pages=max_pages)
        if not page_images:
            raise VisionModelRequestError("PDF could not be rendered to images for OCR", classification="invalid_input")
        return await self._extract_rendered_pdf_pages(page_images)

    async def extract_image(
        self,
        image_bytes: bytes,
        *,
        filename: str = "",
        mime_type: str | None = None,
        max_pages: int = 1,
        **kwargs: Any,
    ) -> dict[str, Any]:
        del filename, max_pages, kwargs
        if not image_bytes:
            raise VisionModelRequestError("Empty image payload received")
        resolved = (mime_type or "image/png").split(";")[0].strip().lower()
        if resolved == "image/tiff":
            raise VisionModelRequestError("TIFF is not supported by the configured single-model OCR path")
        return await self._extract(image_bytes, mime_type=resolved)

    async def _extract(self, data: bytes, *, mime_type: str) -> dict[str, Any]:
        started = time.monotonic()
        if len(data) > self.max_inline_bytes:
            raise VisionModelRequestError(
                f"Document too large for inline AI request ({len(data)} bytes > {self.max_inline_bytes})",
                classification="too_large",
            )

        downscale_info = {"downscaled": False, "original_dims": None, "scaled_dims": None, "bytes_saved_pct": 0.0}
        processed_data = data
        processed_mime = mime_type
        if mime_type.startswith("image/"):
            processed_data, downscale_info = downscale_image_if_needed(data, max_side=self.max_image_side)
            if downscale_info["downscaled"]:
                processed_mime = "image/jpeg"

        cache_key = f"{self.model}:{processed_mime}:{hashlib.sha256(processed_data).hexdigest()}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            payload = json.loads(json.dumps(cached))
            payload["metrics"]["cache_hit"] = True
            payload["metrics"]["processing_seconds"] = round(time.monotonic() - started, 3)
            logger.info(
                "ai_response_cache_hit",
                extra={"model": self.model, "mime_type": processed_mime, "elapsed_ms": int((time.monotonic() - started) * 1000)},
            )
            return payload

        request_started = time.monotonic()
        raw, finish_reason = await self._generate(processed_data, mime_type=processed_mime)
        request_ms = int((time.monotonic() - request_started) * 1000)
        parse_started = time.monotonic()
        _log_raw_ai_response(raw, model=self.model, mime_type=processed_mime)
        parsed = _parse_json(raw)
        pages = None
        if isinstance(parsed, dict):
            if isinstance(parsed.get("pages"), list):
                pages = _normalize_pages(parsed["pages"])
            elif "text" in parsed and isinstance(parsed["text"], str):
                pages = _normalize_pages([{"page": 1, "text": parsed["text"], "confidence": parsed.get("confidence", 0.95)}])

        if not pages and raw and len(raw.strip()) > 0:
            cleaned = re.sub(r"<think>.*?</think>", "", raw, flags=re.DOTALL).strip()
            cleaned = _JSON_FENCE.sub("", cleaned).strip()
            if cleaned:
                pages = _normalize_pages([{"page": 1, "text": cleaned, "confidence": 0.95}])

        if not pages:
            logger.error(
                "ai_response_parse_failed",
                extra={
                    "model": self.model,
                    "mime_type": processed_mime,
                    "response_chars": len(raw or ""),
                    "elapsed_ms": int((time.monotonic() - parse_started) * 1000),
                },
            )
            raise VisionModelOutputError(
                "Configured AI model returned HTTP 200 but the OCR response was not valid text or JSON",
                details={
                    "model": self.model,
                    "mimeType": processed_mime,
                    "responsePreview": _preview(raw),
                    "responseSha256": _sha256(raw),
                    "responseChars": len(raw or ""),
                },
            )

        medical = empty_medical_extraction()
        if isinstance(parsed, dict) and isinstance(parsed.get("medicalExtraction"), dict):
            for key in medical:
                if parsed["medicalExtraction"].get(key) is not None:
                    medical[key] = parsed["medicalExtraction"][key]

        vision_summary = _normalize_summary(parsed.get("summary") if isinstance(parsed, dict) else None, medical=medical)
        client_inst = self._ensure_client()
        telemetry = getattr(raw, "telemetry", None) or getattr(client_inst, "last_telemetry", {})
        payload = _build_payload(
            pages,
            engine=f"{client_inst.engine}:{self.model}",
            medical_extraction=medical,
            vision_summary=vision_summary,
            started=started,
            request_ms=request_ms,
            truncated=finish_reason == "MAX_TOKENS",
            model=self.model,
            telemetry=telemetry,
            downscale_info=downscale_info,
        )

        if payload["metrics"]["non_empty_pages"] > 0 and not payload["metrics"]["truncated"]:
            self._cache.put(cache_key, payload)
        return payload


    async def _extract_rendered_pdf_pages(self, page_images: list[tuple[int, bytes]]) -> dict[str, Any]:
        started = time.monotonic()
        all_pages: list[dict[str, Any]] = []
        medical = empty_medical_extraction()
        summaries: list[dict[str, Any]] = []
        total_request_ms = 0
        truncated = False

        semaphore = asyncio.Semaphore(self.page_concurrency)

        async def process_page(page_number: int, image_bytes: bytes) -> dict[str, Any]:
            request_started = time.monotonic()
            page_prompt = _page_prompt(page_number)
            scaled_bytes, page_downscale_info = downscale_image_if_needed(image_bytes, max_side=self.max_image_side)
            async with semaphore:
                try:
                    raw, finish_reason = await self._generate(
                        scaled_bytes,
                        mime_type="image/jpeg",
                        prompt=page_prompt,
                    )
                    request_ms = int((time.monotonic() - request_started) * 1000)
                    parse_started = time.monotonic()
                    _log_raw_ai_response(raw, model=self.model, mime_type="image/jpeg", page=page_number)
                    parsed = _parse_json(raw)
                    pages = None
                    if isinstance(parsed, dict):
                        if isinstance(parsed.get("pages"), list):
                            pages = _normalize_pages(parsed["pages"])
                        elif "text" in parsed and isinstance(parsed["text"], str):
                            pages = _normalize_pages([{"page": page_number, "text": parsed["text"], "confidence": parsed.get("confidence", 0.95)}])

                    if not pages and raw and len(raw.strip()) > 0:
                        fallback_text = re.sub(r"<think>.*?</think>", "", raw or "", flags=re.DOTALL)
                        fallback_text = _JSON_FENCE.sub("", fallback_text).strip()
                        if fallback_text:
                            logger.info("ai_page_recovered_as_plain_text", extra={"model": self.model, "page": page_number, "chars": len(fallback_text)})
                            pages = _normalize_pages([{"page": page_number, "text": fallback_text, "confidence": 0.85}])

                    if not pages:
                        logger.error(
                            "ai_response_parse_failed",
                            extra={
                                "model": self.model,
                                "page": page_number,
                                "response_chars": len(raw or ""),
                                "elapsed_ms": int((time.monotonic() - parse_started) * 1000),
                            },
                        )
                        return {
                            "page": page_number,
                            "pages": [{"page": page_number, "text": "", "confidence": None}],
                            "medical": None,
                            "summary": None,
                            "request_ms": request_ms,
                            "truncated": finish_reason == "MAX_TOKENS",
                            "error": "invalid_response",
                            "response_preview": _preview(raw),
                            "downscale_info": page_downscale_info,
                        }

                    for page in pages:
                        page["page"] = page_number
                    logger.info(
                        "vision_page_completed",
                        extra={
                            "page": page_number,
                            "image_size_bytes": len(scaled_bytes),
                            "request_ms": request_ms,
                            "response_chars": len(raw or ""),
                            "non_empty": any((page.get("text") or "").strip() for page in pages),
                        },
                    )
                    med_data = parsed.get("medicalExtraction") if (isinstance(parsed, dict) and isinstance(parsed.get("medicalExtraction"), dict)) else None
                    sum_data = _normalize_summary(parsed.get("summary"), medical=medical) if (isinstance(parsed, dict) and isinstance(parsed.get("summary"), dict)) else None
                    page_telemetry = getattr(raw, "telemetry", None) or getattr(self._ensure_client(), "last_telemetry", {})
                    return {
                        "page": page_number,
                        "pages": pages,
                        "medical": med_data,
                        "summary": sum_data,
                        "request_ms": request_ms,
                        "truncated": finish_reason == "MAX_TOKENS",
                        "error": None,
                        "telemetry": page_telemetry,
                        "downscale_info": page_downscale_info,
                    }
                except Exception as exc:
                    request_ms = int((time.monotonic() - request_started) * 1000)
                    kind = _classify_error(exc)
                    logger.error(
                        "vision_page_failed",
                        extra={
                            "page": page_number,
                            "image_size_bytes": len(scaled_bytes),
                            "request_ms": request_ms,
                            "kind": kind,
                            "error": str(exc)[:300],
                        },
                        exc_info=(type(exc), exc, exc.__traceback__),
                    )
                    return {
                        "page": page_number,
                        "pages": [{"page": page_number, "text": "", "confidence": None}],
                        "medical": None,
                        "summary": None,
                        "request_ms": request_ms,
                        "truncated": False,
                        "error": kind,
                        "downscale_info": page_downscale_info,
                    }

        results = await asyncio.gather(*(process_page(page_number, image_bytes) for page_number, image_bytes in page_images))
        page_errors: list[str] = []
        for result in sorted(results, key=lambda item: item["page"]):
            total_request_ms += int(result.get("request_ms") or 0)
            truncated = truncated or bool(result.get("truncated"))
            if result.get("error"):
                page_errors.append(str(result["error"]))
            all_pages.extend(result["pages"])
            if isinstance(result.get("medical"), dict):
                _merge_medical_extraction(medical, result["medical"])
            if isinstance(result.get("summary"), dict):
                summaries.append(result["summary"])

        if not all_pages:
            raise VisionModelOutputError(
                "Configured AI model returned HTTP 200 but no OCR pages",
                details={"model": self.model, "renderedPageCount": len(page_images)},
            )

        vision_summary = _combine_summaries(summaries, medical=medical)
        pdf_telemetry = {"pages": [r.get("telemetry") for r in results if r.get("telemetry")]}
        any_downscaled = any(bool(r.get("downscale_info", {}).get("downscaled")) for r in results)
        payload = _build_payload(
            all_pages,
            engine=f"{self._ensure_client().engine}:{self.model}",
            medical_extraction=medical,
            vision_summary=vision_summary,
            started=started,
            request_ms=total_request_ms,
            truncated=truncated,
            model=self.model,
            telemetry=pdf_telemetry,
            downscale_info={"downscaled": any_downscaled, "original_dims": None, "scaled_dims": None, "bytes_saved_pct": 0.0},
        )
        payload["metrics"]["pdf_rendered_to_images"] = True
        payload["metrics"]["rendered_page_count"] = len(page_images)
        payload["metrics"]["page_errors"] = page_errors
        payload["metrics"]["page_concurrency"] = self.page_concurrency
        return payload

    async def _generate(self, data: bytes, *, mime_type: str, prompt: str | None = None) -> tuple[str, str | None]:
        actual_prompt = prompt or _OCR_PROMPT
        try:
            client = self._ensure_client()
            try:
                return await client.generate_json_from_bytes(
                    data=data,
                    mime_type=mime_type,
                    prompt=actual_prompt,
                    json_only=False,
                )
            except TypeError:
                return await client.generate_json_from_bytes(
                    data=data,
                    mime_type=mime_type,
                    prompt=actual_prompt,
                )
        except Exception as exc:
            if globals().get("global_ocr") is not None:
                logger.warning("Primary AI client failed (%s); attempting PaddleOCR fallback", exc)
                return self._generate_paddleocr(data, mime_type=mime_type)
            kind = _classify_error(exc)
            logger.error("ai_request_error", extra={"engine": getattr(getattr(self, "_client", None), "engine", "ai-client"), "model": self.model, "kind": kind, "error": str(exc)[:300]})
            raise VisionModelRequestError(f"AI vision request failed: {exc}", classification=kind) from exc

    def _generate_paddleocr(self, data: bytes, *, mime_type: str) -> tuple[str, str | None]:
        try:
            t0 = time.monotonic()
            img_array = np.frombuffer(data, np.uint8)
            img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
            if img is None:
                raise ValueError("Failed to decode image bytes for PaddleOCR")
            result = global_ocr.ocr(img)
            extracted_text = ""
            if result and result[0]:
                if isinstance(result[0], dict) and "rec_texts" in result[0]:
                    extracted_text = "\n".join(result[0]["rec_texts"])
                elif isinstance(result[0], list) and isinstance(result[0][0], (list, tuple)) and len(result[0][0]) > 1:
                    try:
                        extracted_text = "\n".join([line[1][0] for line in result[0]])
                    except Exception:
                        pass
            structured_json = {
                "pages": [{"page": 1, "text": extracted_text, "confidence": 0.95}],
                "medicalExtraction": empty_medical_extraction(),
                "summary": empty_summary()
            }
            logger.info("paddleocr_fallback_completed", extra={"chars": len(extracted_text), "elapsed_ms": int((time.monotonic() - t0) * 1000)})
            return json.dumps(structured_json), "STOP"
        except Exception as exc:
            raise VisionModelRequestError(f"PaddleOCR fallback failed: {exc}") from exc


def _render_pdf_pages_to_png(pdf_bytes: bytes, *, max_pages: int) -> list[tuple[int, bytes]]:
    try:
        import fitz
    except Exception as exc:  # pragma: no cover - dependency is declared in requirements
        raise VisionModelRequestError("PyMuPDF is required to render scanned PDFs for local vision OCR") from exc

    images: list[tuple[int, bytes]] = []
    try:
        render_started = time.monotonic()
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            page_limit = min(max(1, int(max_pages)), int(doc.page_count))
            for index in range(page_limit):
                page = doc.load_page(index)
                pix = page.get_pixmap(matrix=fitz.Matrix(1.0, 1.0), alpha=False)
                try:
                    image_bytes = pix.tobytes("jpeg", jpg_quality=88)
                except Exception:
                    image_bytes = pix.tobytes("png")
                images.append((index + 1, image_bytes))
                logger.info(
                    "pdf_page_rendered",
                    extra={
                        "page": index + 1,
                        "width": pix.width,
                        "height": pix.height,
                        "image_size_bytes": len(image_bytes),
                    },
                )
        logger.info(
            "pdf_render_completed",
            extra={
                "rendered_page_count": len(images),
                "bytes": sum(len(image) for _, image in images),
                "elapsed_ms": int((time.monotonic() - render_started) * 1000),
            },
        )
    except Exception as exc:
        raise VisionModelRequestError(f"Failed to render PDF pages for OCR: {exc}", classification="invalid_input") from exc
    return images


def _page_prompt(page_number: int) -> str:
    return (
        f"You are an accurate OCR engine for medical documents. "
        f"Transcribe ALL visible text on page {page_number} exactly as it appears in clean markdown/plain text. "
        f"Preserve line breaks, exact numbers, test names, values, units, reference intervals, dates, and tabular column alignments. "
        f"Do not summarize, interpret, translate, or omit any text. "
        f"Output ONLY the transcribed text for page {page_number}."
    )


def _merge_medical_extraction(target: dict[str, Any], source: dict[str, Any]) -> None:
    for key in target:
        value = source.get(key)
        if value in (None, "", [], {}):
            continue
        if isinstance(target.get(key), list):
            items = value if isinstance(value, list) else [value]
            for item in items:
                if item not in target[key]:
                    target[key].append(item)
        elif isinstance(target.get(key), dict):
            if isinstance(value, dict):
                target[key].update({k: v for k, v in value.items() if v not in (None, "", [], {})})
        else:
            target[key] = value


def _combine_summaries(summaries: list[dict[str, Any]], *, medical: dict[str, Any]) -> dict[str, Any]:
    combined = empty_summary()
    for summary in summaries:
        if not isinstance(summary, dict):
            continue
        if summary.get("type"):
            combined["type"] = summary["type"]
        for key in ("summary", "medications", "tests", "warnings", "follow_up"):
            values = summary.get(key) or []
            if not isinstance(values, list):
                values = [values]
            for value in values:
                text = value if isinstance(value, str) else json.dumps(value, ensure_ascii=False)
                text = text.strip()
                if text and text not in combined[key]:
                    combined[key].append(text)

    fallback = _normalize_summary(None, medical=medical)
    for key in ("summary", "medications", "tests", "warnings", "follow_up"):
        if not combined[key]:
            combined[key] = fallback[key]
    return combined

def _classify_error(exc: BaseException | None) -> str:
    if exc is None:
        return "error"
    name = type(exc).__name__.lower()
    status = getattr(exc, "code", None) or getattr(exc, "status_code", None)
    message = str(exc).lower()
    if "timeout" in name or "timeout" in message or "deadline" in message:
        return "timeout"
    if status == 429 or "429" in message or "resource_exhausted" in message or "quota" in message:
        return "rate_limit"
    if status == 400 or "invalid_argument" in message or "400" in message:
        return "client_error"
    return "error"


def _parse_json(raw: str) -> dict[str, Any] | None:
    if not raw:
        return None
    try:
        parsed = parse_json_object(raw)
        return parsed if isinstance(parsed, dict) else None
    except Exception:
        return None


def _log_raw_ai_response(raw: str, *, model: str, mime_type: str, page: int | None = None) -> None:
    logger.info(
        "ai_raw_response_received",
        extra={
            "model": model,
            "mime_type": mime_type,
            "page": page,
            "response_chars": len(raw or ""),
            "response_sha256": _sha256(raw),
            "response_preview": _preview(raw),
        },
    )


def _preview(raw: str | None, limit: int = 1000) -> str:
    value = raw or ""
    return value if len(value) <= limit else f"{value[:limit]}...[+{len(value) - limit} chars]"


def _sha256(raw: str | None) -> str:
    return hashlib.sha256((raw or "").encode("utf-8")).hexdigest()


def _normalize_pages(raw_pages: list[Any]) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    for index, page in enumerate(raw_pages):
        if not isinstance(page, dict):
            continue
        text = clean_ocr_text(str(page.get("text") or ""))
        confidence = page.get("confidence")
        pages.append(
            {
                "page": int(page.get("page") or index + 1),
                "text": text,
                "confidence": float(confidence) if isinstance(confidence, (int, float)) else None,
            }
        )
    return pages


def _normalize_summary(raw: Any, *, medical: dict[str, Any]) -> dict[str, Any]:
    def _as_str_list(value: Any) -> list[str]:
        if value is None:
            return []
        items = value if isinstance(value, list) else [value]
        out: list[str] = []
        for item in items:
            text = item if isinstance(item, str) else json.dumps(item, ensure_ascii=False)
            if text.strip():
                out.append(text.strip())
        return out

    summary = empty_summary()
    if isinstance(raw, dict):
        summary["type"] = raw.get("type") or "medical"
        summary["summary"] = _as_str_list(raw.get("summary"))
        summary["medications"] = _as_str_list(raw.get("medications"))
        summary["tests"] = _as_str_list(raw.get("tests"))
        summary["warnings"] = _as_str_list(raw.get("warnings"))
        summary["follow_up"] = _as_str_list(raw.get("follow_up"))
    if not summary["medications"]:
        summary["medications"] = _as_str_list(medical.get("medications"))
    if not summary["tests"]:
        summary["tests"] = _as_str_list(medical.get("labResults"))
    if not summary["summary"] and isinstance(medical.get("summary"), str) and medical["summary"].strip():
        summary["summary"] = [medical["summary"].strip()]
    if not summary["follow_up"]:
        summary["follow_up"] = _as_str_list(medical.get("recommendations"))
    return summary


def _build_payload(
    pages: list[dict[str, Any]],
    *,
    engine: str,
    medical_extraction: dict[str, Any],
    vision_summary: dict[str, Any] | None,
    started: float,
    request_ms: int,
    truncated: bool,
    model: str,
    telemetry: dict[str, Any] | None = None,
    downscale_info: dict[str, Any] | None = None,
) -> dict[str, Any]:
    downscale_info = downscale_info or {}
    page_payloads = []
    for page in pages:
        text = page["text"]
        lines = [{"text": line, "confidence": None} for line in text.splitlines() if line.strip()]
        page_payloads.append(
            {
                "page": page["page"],
                "text": text,
                "confidence": page.get("confidence"),
                "lines": lines,
                "elapsed_ms": 0,
            }
        )

    full_text = "\n\n".join(p["text"] for p in pages if p["text"]).strip()
    non_empty = sum(1 for p in pages if p["text"].strip())
    confidences = [p["confidence"] for p in pages if isinstance(p.get("confidence"), (int, float))]
    mean_conf = round(sum(confidences) / len(confidences), 4) if confidences else None
    paragraphs = [
        {"text": line["text"], "confidence": None, "page": page["page"], "label": "line", "order": order}
        for page in page_payloads
        for order, line in enumerate(page["lines"])
    ]

    return {
        "pages": page_payloads,
        "text": full_text,
        "fullText": full_text,
        "confidence": mean_conf,
        "pageCount": len(page_payloads),
        "processedPageCount": len(page_payloads),
        "paragraphs": paragraphs,
        "medicalExtraction": medical_extraction,
        "visionSummary": vision_summary,
        "metrics": {
            "client_engine": engine.split(":", 1)[0],
            "engine": engine,
            "model": model,
            "used_ocr": True,
            "used_ai_model": True,
            "used_direct_text": False,
            "used_fallback": False,
            "fallback_used": False,
            "truncated": truncated,
            "cache_hit": False,
            "summary_from_vision": vision_summary is not None,
            "non_empty_pages": non_empty,
            "full_text_chars": len(full_text),
            "mean_confidence": mean_conf,
            "request_ms": request_ms,
            "vision_ms": int((time.monotonic() - started) * 1000),
            "processing_seconds": round(time.monotonic() - started, 3),
            "telemetry": telemetry or {},
            "vlm_downscaled": bool(downscale_info.get("downscaled", False)),
            "vlm_original_dims": downscale_info.get("original_dims"),
            "vlm_scaled_dims": downscale_info.get("scaled_dims"),
            "vlm_bytes_saved_pct": float(downscale_info.get("bytes_saved_pct", 0.0)),
        },
    }
