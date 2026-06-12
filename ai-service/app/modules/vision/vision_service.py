from __future__ import annotations

import hashlib
import json
import logging
import re
import asyncio
import threading
import time
from collections import OrderedDict
from typing import Any

from app.core.errors import ModelUnavailableError, OcrEmptyResultError
from app.modules.ocr.cleanup import clean_ocr_text
from app.services.ai_client import AiClient, AiClientConfig, build_ai_client

logger = logging.getLogger(__name__)

_JSON_FENCE = re.compile(r"```(?:json)?|```", re.IGNORECASE)

_OCR_PROMPT = (
    "You are a precise OCR and document-understanding engine for medical documents. "
    "Transcribe ALL visible text exactly as it appears and return ONLY JSON in this shape: "
    '{"pages":[{"page":1,"text":"","confidence":0.0}],'
    '"medicalExtraction":{"patientInfo":{},"hospitalInfo":{},"doctorInfo":{},'
    '"diagnosis":[],"medications":[],"labResults":[],"vitals":[],"recommendations":[],"summary":""},'
    '"summary":{"type":"","summary":[],"medications":[],"tests":[],"warnings":[],"follow_up":[]}}. '
    "Never invent values. Preserve line breaks, numbers, units, dates, names, and tables."
)


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

    async def extract_pdf(self, pdf_bytes: bytes, *, max_pages: int) -> dict[str, Any]:
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
        filename: str,
        mime_type: str | None,
        max_pages: int,
    ) -> dict[str, Any]:
        del filename, max_pages
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

        cache_key = f"{self.model}:{mime_type}:{hashlib.sha256(data).hexdigest()}"
        cached = self._cache.get(cache_key)
        if cached is not None:
            payload = json.loads(json.dumps(cached))
            payload["metrics"]["cache_hit"] = True
            payload["metrics"]["processing_seconds"] = round(time.monotonic() - started, 3)
            logger.info(
                "ai_response_cache_hit",
                extra={"model": self.model, "mime_type": mime_type, "elapsed_ms": int((time.monotonic() - started) * 1000)},
            )
            return payload

        request_started = time.monotonic()
        raw, finish_reason = await self._generate(data, mime_type=mime_type)
        request_ms = int((time.monotonic() - request_started) * 1000)
        parse_started = time.monotonic()
        _log_raw_ai_response(raw, model=self.model, mime_type=mime_type)
        parsed = _parse_json(raw)
        if not isinstance(parsed, dict) or not isinstance(parsed.get("pages"), list):
            logger.error(
                "ai_response_parse_failed",
                extra={
                    "model": self.model,
                    "mime_type": mime_type,
                    "response_chars": len(raw or ""),
                    "elapsed_ms": int((time.monotonic() - parse_started) * 1000),
                },
            )
            raise VisionModelOutputError(
                "Configured AI model returned HTTP 200 but the OCR response was not valid JSON with a pages array",
                details={
                    "model": self.model,
                    "mimeType": mime_type,
                    "responsePreview": _preview(raw),
                    "responseSha256": _sha256(raw),
                    "responseChars": len(raw or ""),
                },
            )

        pages = _normalize_pages(parsed["pages"])
        if not pages:
            raise VisionModelOutputError(
                "Configured AI model returned HTTP 200 but no OCR pages",
                details={"model": self.model, "mimeType": mime_type, "responsePreview": _preview(raw)},
            )

        medical = empty_medical_extraction()
        if isinstance(parsed.get("medicalExtraction"), dict):
            for key in medical:
                if parsed["medicalExtraction"].get(key) is not None:
                    medical[key] = parsed["medicalExtraction"][key]

        vision_summary = _normalize_summary(parsed.get("summary"), medical=medical)
        payload = _build_payload(
            pages,
            engine=f"{self._ensure_client().engine}:{self.model}",
            medical_extraction=medical,
            vision_summary=vision_summary,
            started=started,
            request_ms=request_ms,
            truncated=finish_reason == "MAX_TOKENS",
            model=self.model,
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
            async with semaphore:
                try:
                    raw, finish_reason = await self._generate(
                        image_bytes,
                        mime_type="image/png",
                        prompt=page_prompt,
                    )
                    request_ms = int((time.monotonic() - request_started) * 1000)
                    parse_started = time.monotonic()
                    _log_raw_ai_response(raw, model=self.model, mime_type="image/png", page=page_number)
                    parsed = _parse_json(raw)
                    if not isinstance(parsed, dict) or not isinstance(parsed.get("pages"), list):
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
                        }

                    pages = _normalize_pages(parsed["pages"])
                    if not pages:
                        pages = [{"page": page_number, "text": "", "confidence": None}]
                    for page in pages:
                        page["page"] = page_number
                    logger.info(
                        "vision_page_completed",
                        extra={
                            "page": page_number,
                            "image_size_bytes": len(image_bytes),
                            "request_ms": request_ms,
                            "response_chars": len(raw or ""),
                            "non_empty": any((page.get("text") or "").strip() for page in pages),
                        },
                    )
                    return {
                        "page": page_number,
                        "pages": pages,
                        "medical": parsed.get("medicalExtraction") if isinstance(parsed.get("medicalExtraction"), dict) else None,
                        "summary": _normalize_summary(parsed.get("summary"), medical=medical) if isinstance(parsed.get("summary"), dict) else None,
                        "request_ms": request_ms,
                        "truncated": finish_reason == "MAX_TOKENS",
                        "error": None,
                    }
                except Exception as exc:
                    request_ms = int((time.monotonic() - request_started) * 1000)
                    kind = _classify_error(exc)
                    logger.error(
                        "vision_page_failed",
                        extra={
                            "page": page_number,
                            "image_size_bytes": len(image_bytes),
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
        payload = _build_payload(
            all_pages,
            engine=f"{self._ensure_client().engine}:{self.model}",
            medical_extraction=medical,
            vision_summary=vision_summary,
            started=started,
            request_ms=total_request_ms,
            truncated=truncated,
            model=self.model,
        )
        payload["metrics"]["pdf_rendered_to_images"] = True
        payload["metrics"]["rendered_page_count"] = len(page_images)
        payload["metrics"]["page_errors"] = page_errors
        payload["metrics"]["page_concurrency"] = self.page_concurrency
        return payload

    async def _generate(self, data: bytes, *, mime_type: str, prompt: str | None = None) -> tuple[str, str | None]:
        client = self._ensure_client()
        t0 = time.monotonic()
        try:
            text, finish_reason = await client.generate_json_from_bytes(
                data=data,
                mime_type=mime_type,
                prompt=prompt or _OCR_PROMPT,
                temperature=0,
            )
        except Exception as exc:
            kind = _classify_error(exc)
            logger.error("ai_request_error", extra={"engine": client.engine, "model": self.model, "kind": kind, "error": str(exc)[:300]})
            raise VisionModelRequestError(f"Configured AI model request failed: {exc}", classification=kind) from exc

        logger.info(
            "ai_response_received",
            extra={
                "engine": client.engine,
                "model": self.model,
                "response_chars": len(text),
                "finish_reason": finish_reason,
                "elapsed_ms": int((time.monotonic() - t0) * 1000),
            },
        )
        if not text.strip():
            raise VisionModelOutputError(
                "Configured AI model returned HTTP 200 but an empty response body",
                details={"model": self.model, "mimeType": mime_type, "finishReason": finish_reason},
            )
        return text, finish_reason


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
                # 1.0x render keeps Ollama vision payloads small. The prior
                # 1.5x render inflated each page by roughly 2.25x pixels and
                # made six-page PDFs fan out into multi-minute requests.
                pix = page.get_pixmap(matrix=fitz.Matrix(1.0, 1.0), alpha=False)
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
        f"You are OCRing page {page_number} of a PDF document. "
        "Transcribe ALL visible text exactly as it appears on this page and return ONLY JSON in this shape: "
        f'{{"pages":[{{"page":{page_number},"text":"","confidence":0.0}}],'
        '"medicalExtraction":{"patientInfo":{},"hospitalInfo":{},"doctorInfo":{},'
        '"diagnosis":[],"medications":[],"labResults":[],"vitals":[],"recommendations":[],"summary":""},'
        '"summary":{"type":"","summary":[],"medications":[],"tests":[],"warnings":[],"follow_up":[]}}. '
        "Never invent values. Preserve line breaks, numbers, units, dates, names, and tables."
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
    candidate = _JSON_FENCE.sub("", raw.strip()).strip()
    for value in (candidate, _extract_first_json_object(candidate)):
        if not value:
            continue
        try:
            parsed = json.loads(value)
            return parsed if isinstance(parsed, dict) else None
        except json.JSONDecodeError:
            continue
    return None


def _extract_first_json_object(text: str) -> str | None:
    start = text.find("{")
    if start < 0:
        return None
    depth = 0
    in_string = False
    escape = False
    for index in range(start, len(text)):
        char = text[index]
        if in_string:
            if escape:
                escape = False
            elif char == "\\":
                escape = True
            elif char == '"':
                in_string = False
            continue
        if char == '"':
            in_string = True
        elif char == "{":
            depth += 1
        elif char == "}":
            depth -= 1
            if depth == 0:
                return text[start : index + 1]
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
) -> dict[str, Any]:
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
        },
    }
