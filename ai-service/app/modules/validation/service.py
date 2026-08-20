from __future__ import annotations

import base64
import io
import json
import logging
import re
import time
from typing import Any

import httpx
from PIL import Image

from app.api.v1.schemas.validation import MedicalValidationResponse, ValidationMetrics
from app.modules.validation.prompts import MEDGEMMA_VISION_CLASSIFICATION_PROMPT
from app.modules.vision.vision_service import _render_pdf_pages_to_png
from app.settings import Settings

logger = logging.getLogger(__name__)


class MedGemmaUnavailableError(Exception):
    """Raised when MedGemma model is not installed/reachable on Ollama."""
    pass


class InvalidDocumentFileError(Exception):
    """Raised when document bytes cannot be parsed/read."""
    pass


ALLOWED_DOCUMENT_TYPES = {
    "PRESCERIPTION",
    "LAB_REPORT",
    "IMAGING_REPORT",
    "DISCHARGE_SUMMARY",
    "CONSULTATION_REPORT",
    "SURGERY_PROCEDURE_REPORT",
    "VACCINATION_RECORD",
    "MEDICAL_CERTIFICATE",
    "OTHER_MEDICAL_DOCUMENT",
}

ALIAS_MAP = {
    # Prescription
    "prescription": "PRESCERIPTION",
    "prescriptions": "PRESCERIPTION",
    "rx": "PRESCERIPTION",
    "prescription slip": "PRESCERIPTION",
    "prescription slips": "PRESCERIPTION",
    "presceription": "PRESCERIPTION",
    # Lab report
    "lab": "LAB_REPORT",
    "lab report": "LAB_REPORT",
    "lab_report": "LAB_REPORT",
    "laboratory report": "LAB_REPORT",
    "lab test": "LAB_REPORT",
    "test report": "LAB_REPORT",
    "blood test": "LAB_REPORT",
    "blood report": "LAB_REPORT",
    "blood_report": "LAB_REPORT",
    "cbc": "LAB_REPORT",
    "cbc report": "LAB_REPORT",
    "cbc_report": "LAB_REPORT",
    "cbc test": "LAB_REPORT",
    "pathology": "LAB_REPORT",
    "pathology report": "LAB_REPORT",
    "biochemistry": "LAB_REPORT",
    "biochemistry report": "LAB_REPORT",
    "lipid profile": "LAB_REPORT",
    "thyroid": "LAB_REPORT",
    "thyroid report": "LAB_REPORT",
    "blood work": "LAB_REPORT",
    # Imaging report
    "imaging": "IMAGING_REPORT",
    "imaging report": "IMAGING_REPORT",
    "imaging_report": "IMAGING_REPORT",
    "x-ray": "IMAGING_REPORT",
    "xray": "IMAGING_REPORT",
    "x_ray": "IMAGING_REPORT",
    "mri": "IMAGING_REPORT",
    "mri report": "IMAGING_REPORT",
    "mri_report": "IMAGING_REPORT",
    "ct": "IMAGING_REPORT",
    "ct scan": "IMAGING_REPORT",
    "ct_scan": "IMAGING_REPORT",
    "ct scan report": "IMAGING_REPORT",
    "ultrasound": "IMAGING_REPORT",
    "sonography": "IMAGING_REPORT",
    "radiograph": "IMAGING_REPORT",
    "radiology": "IMAGING_REPORT",
    "scan": "IMAGING_REPORT",
    "x-ray / mri / ct scan report": "IMAGING_REPORT",
    "x-ray/mri/ct scan report": "IMAGING_REPORT",
    "x ray mri ct scan report": "IMAGING_REPORT",
    "xray mri ct scan report": "IMAGING_REPORT",
    # Discharge summary
    "discharge": "DISCHARGE_SUMMARY",
    "discharge summary": "DISCHARGE_SUMMARY",
    "discharge_summary": "DISCHARGE_SUMMARY",
    "hospital discharge": "DISCHARGE_SUMMARY",
    "hospital discharge summary": "DISCHARGE_SUMMARY",
    "discharge report": "DISCHARGE_SUMMARY",
    # Consultation report
    "consultation": "CONSULTATION_REPORT",
    "consultation report": "CONSULTATION_REPORT",
    "consultation_report": "CONSULTATION_REPORT",
    "doctor note": "CONSULTATION_REPORT",
    "doctor notes": "CONSULTATION_REPORT",
    "doctor_note": "CONSULTATION_REPORT",
    "clinical note": "CONSULTATION_REPORT",
    "clinical notes": "CONSULTATION_REPORT",
    "symptoms": "CONSULTATION_REPORT",
    "opd note": "CONSULTATION_REPORT",
    "outpatient note": "CONSULTATION_REPORT",
    # Surgery / Procedure report
    "surgery": "SURGERY_PROCEDURE_REPORT",
    "surgery report": "SURGERY_PROCEDURE_REPORT",
    "surgery_report": "SURGERY_PROCEDURE_REPORT",
    "procedure": "SURGERY_PROCEDURE_REPORT",
    "procedure report": "SURGERY_PROCEDURE_REPORT",
    "procedure_report": "SURGERY_PROCEDURE_REPORT",
    "operation report": "SURGERY_PROCEDURE_REPORT",
    "operative note": "SURGERY_PROCEDURE_REPORT",
    "surgical report": "SURGERY_PROCEDURE_REPORT",
    # Vaccination record
    "vaccine": "VACCINATION_RECORD",
    "vaccination": "VACCINATION_RECORD",
    "vaccination record": "VACCINATION_RECORD",
    "vaccination_record": "VACCINATION_RECORD",
    "immunization": "VACCINATION_RECORD",
    "immunization record": "VACCINATION_RECORD",
    # Medical certificate
    "certificate": "MEDICAL_CERTIFICATE",
    "medical certificate": "MEDICAL_CERTIFICATE",
    "medical_certificate": "MEDICAL_CERTIFICATE",
    "fitness certificate": "MEDICAL_CERTIFICATE",
    "illness certificate": "MEDICAL_CERTIFICATE",
    "leave certificate": "MEDICAL_CERTIFICATE",
    "medical leave certificate": "MEDICAL_CERTIFICATE",
    "sick note": "MEDICAL_CERTIFICATE",
    # Other medical document
    "other medical document": "OTHER_MEDICAL_DOCUMENT",
    "other_medical_document": "OTHER_MEDICAL_DOCUMENT",
    "other medical report": "OTHER_MEDICAL_DOCUMENT",
    "medical document": "OTHER_MEDICAL_DOCUMENT",
    "medical_document": "OTHER_MEDICAL_DOCUMENT",
    "medical report": "OTHER_MEDICAL_DOCUMENT",
    "pharmacy bill": "OTHER_MEDICAL_DOCUMENT",
    "medical invoice": "OTHER_MEDICAL_DOCUMENT",
    "medical bill": "OTHER_MEDICAL_DOCUMENT",
    "ecg": "OTHER_MEDICAL_DOCUMENT",
    "ecg report": "OTHER_MEDICAL_DOCUMENT",
    "ekg": "OTHER_MEDICAL_DOCUMENT",
    "heart rate": "OTHER_MEDICAL_DOCUMENT",
    "medical chart": "OTHER_MEDICAL_DOCUMENT",
}


class MedicalValidationService:
    def __init__(self, settings: Settings, storage: Any) -> None:
        self.settings = settings
        self.storage = storage
        self._tag_cache: dict[str, Any] = {"tags": set(), "timestamp": 0.0}

    def _resolve_ollama_base_url(self) -> str:
        base = self.settings.ollama_base_url or self.settings.ai_base_url
        clean = base.rstrip("/")
        if clean.endswith("/v1"):
            clean = clean[:-3]
        return clean

    async def _get_installed_models(self) -> set[str]:
        now = time.monotonic()
        if now - self._tag_cache["timestamp"] < 60.0 and self._tag_cache["tags"]:
            return self._tag_cache["tags"]

        base_url = self._resolve_ollama_base_url()
        try:
            async with httpx.AsyncClient(timeout=10.0) as client:
                resp = await client.get(f"{base_url}/api/tags")
                if resp.status_code == 200:
                    data = resp.json()
                    models = {m.get("name") for m in data.get("models", []) if m.get("name")}
                    self._tag_cache = {"tags": models, "timestamp": now}
                    return models
        except Exception as exc:
            logger.warning("Failed to fetch Ollama tags for preflight: %s", exc)

        return self._tag_cache.get("tags", set())

    async def is_model_available(self, model_name: str) -> bool:
        installed = await self._get_installed_models()
        if not installed:
            return True
        if model_name in installed:
            return True
        base_name = model_name.split(":")[0]
        return any(m == model_name or m.startswith(f"{base_name}:") for m in installed)

    def _downscale_image(self, image_bytes: bytes, max_dim: int = 1536) -> bytes:
        try:
            with Image.open(io.BytesIO(image_bytes)) as img:
                img = img.convert("RGB")
                w, h = img.size
                if max(w, h) > max_dim:
                    if w > h:
                        new_w = max_dim
                        new_h = int(h * (max_dim / w))
                    else:
                        new_h = max_dim
                        new_w = int(w * (max_dim / h))
                    img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
                
                out_io = io.BytesIO()
                img.save(out_io, format="JPEG", quality=85)
                return out_io.getvalue()
        except Exception as exc:
            raise InvalidDocumentFileError(f"Failed to process image: {exc}") from exc

    def _clean_and_parse_json(self, raw_text: str) -> dict[str, Any] | None:
        if not raw_text or not raw_text.strip():
            return None

        cleaned = raw_text.strip()
        if "```" in cleaned:
            match = re.search(r"```(?:json)?\s*([\s\S]*?)\s*```", cleaned, re.IGNORECASE)
            if match:
                cleaned = match.group(1).strip()

        try:
            return json.loads(cleaned)
        except Exception:
            start = cleaned.find("{")
            end = cleaned.rfind("}")
            if start != -1 and end != -1 and end > start:
                try:
                    return json.loads(cleaned[start : end + 1])
                except Exception:
                    pass
        return None

    def _normalize_document_type(self, raw_type: str | None, is_medical: bool) -> str | None:
        if not is_medical:
            return None
        if not raw_type or not isinstance(raw_type, str):
            return "OTHER_MEDICAL_DOCUMENT"

        cleaned = raw_type.strip()
        if not cleaned:
            return "OTHER_MEDICAL_DOCUMENT"

        upper_val = cleaned.upper()
        if upper_val in ALLOWED_DOCUMENT_TYPES:
            return upper_val

        lower_val = cleaned.lower()
        if lower_val in ALIAS_MAP:
            return ALIAS_MAP[lower_val]

        normalized = re.sub(r"[\s\-_/\.]+", " ", lower_val).strip()
        if normalized in ALIAS_MAP:
            return ALIAS_MAP[normalized]

        underscore_normalized = re.sub(r"[\s\-_/\.]+", "_", lower_val).strip()
        if underscore_normalized in ALIAS_MAP:
            return ALIAS_MAP[underscore_normalized]

        if re.search(r"\b(x-ray|xray|mri|ct|ct scan|ultrasound|sonography|imaging|radiology|radiograph)\b", lower_val):
            return "IMAGING_REPORT"
        if re.search(r"\b(blood|cbc|lab|labs|laboratory|pathology|biochemistry)\b", lower_val):
            return "LAB_REPORT"
        if re.search(r"\b(prescription|prescriptions|presceription|rx)\b", lower_val):
            return "PRESCERIPTION"
        if re.search(r"\b(discharge)\b", lower_val):
            return "DISCHARGE_SUMMARY"
        if re.search(r"\b(consultation|doctor note|clinical note|opd note)\b", lower_val):
            return "CONSULTATION_REPORT"
        if re.search(r"\b(surgery|procedure|operation|operative)\b", lower_val):
            return "SURGERY_PROCEDURE_REPORT"
        if re.search(r"\b(vaccin|vaccine|vaccination|immuniz|immunization)\b", lower_val):
            return "VACCINATION_RECORD"
        if re.search(r"\b(certificate)\b", lower_val):
            return "MEDICAL_CERTIFICATE"

        return "OTHER_MEDICAL_DOCUMENT"

    async def validate_medical_document(
        self,
        *,
        bucket: str | None = None,
        file_key: str | None = None,
        mime_type: str | None = None,
        max_pages: int | None = None,
        trace_id: str | None = None,
        text: str | None = None,
        file_bytes: bytes | None = None,
        file_name: str | None = None,
    ) -> MedicalValidationResponse:
        started = time.monotonic()
        trace = trace_id or f"trace_{int(time.time()*1000)}"
        model_name = self.settings.medgemma_model
        timeout_sec = float(self.settings.medgemma_timeout_ms) / 1000.0
        pages_limit = max_pages or self.settings.medgemma_max_pages
        base_url = self._resolve_ollama_base_url()
        effective_filename = file_name or file_key or ""

        logger.info(
            "medical_validation_started",
            extra={"trace_id": trace, "file_key": effective_filename, "model": model_name},
        )

        if file_bytes is not None:
            document_bytes = file_bytes
        else:
            if not file_key or not file_key.strip():
                raise InvalidDocumentFileError("fileKey is required when file_bytes is not provided")
            try:
                document_bytes = await self.storage.read_bytes(
                    bucket=bucket or (self.settings.aws_bucket_name if self.settings.resolve_storage_provider() == "s3" else self.settings.gcp_storage_bucket),
                    key=file_key,
                )
            except Exception as exc:
                logger.error("medical_validation_storage_read_failed", extra={"trace_id": trace, "error": str(exc)})
                raise InvalidDocumentFileError(f"Unable to read file from storage: {exc}") from exc

        if not document_bytes or len(document_bytes) == 0:
            raise InvalidDocumentFileError("Uploaded file is empty" if file_bytes is not None else "File in storage is empty")

        model_ok = await self.is_model_available(model_name)
        if not model_ok:
            if self.settings.medgemma_fallback != "text_classifier":
                raise MedGemmaUnavailableError(f"Model {model_name} is not installed on Ollama server")
            logger.warning(
                "medical_validation_model_unavailable_fallback",
                extra={"trace_id": trace, "model": model_name},
            )

        is_pdf = (
            (mime_type and "pdf" in mime_type.lower())
            or effective_filename.lower().endswith(".pdf")
            or document_bytes.startswith(b"%PDF")
        )

        base64_images: list[str] = []
        pages_used = 1

        if is_pdf:
            try:
                rendered = _render_pdf_pages_to_png(document_bytes, max_pages=pages_limit)
                pages_used = len(rendered)
                for _, png_data in rendered:
                    downscaled = self._downscale_image(png_data)
                    base64_images.append(base64.b64encode(downscaled).decode("utf-8"))
            except Exception as exc:
                logger.error("medical_validation_pdf_render_failed", extra={"trace_id": trace, "error": str(exc)})
                raise InvalidDocumentFileError(f"Failed to render PDF: {exc}") from exc
        else:
            downscaled = self._downscale_image(document_bytes)
            base64_images.append(base64.b64encode(downscaled).decode("utf-8"))

        if not base64_images:
            raise InvalidDocumentFileError("No usable images extracted from document")

        method = "vision"
        resolved_model = model_name
        parsed: dict[str, Any] | None = None

        if model_ok:
            try:
                async with httpx.AsyncClient(timeout=timeout_sec) as client:
                    payload = {
                        "model": model_name,
                        "prompt": MEDGEMMA_VISION_CLASSIFICATION_PROMPT,
                        "images": base64_images,
                        "stream": False,
                        "format": "json",
                        "keep_alive": "10m",
                        "options": {"temperature": 0.0, "num_predict": 100},
                    }
                    resp = await client.post(f"{base_url}/api/generate", json=payload)
                    if resp.status_code == 200:
                        raw_out = resp.json().get("response", "")
                        parsed = self._clean_and_parse_json(raw_out)
                    else:
                        logger.warning("Ollama vision returned HTTP %s: %s", resp.status_code, resp.text[:200])
            except Exception as exc:
                logger.warning("Ollama vision call failed: %s", exc)

        if parsed is None:
            if self.settings.medgemma_fallback == "text_classifier":
                method = "fallback"
                resolved_model = self.settings.ai_model
                try:
                    text_content = text or f"Document filename: {effective_filename}"
                    async with httpx.AsyncClient(timeout=timeout_sec) as client:
                        payload = {
                            "model": self.settings.ai_model,
                            "prompt": f"{MEDGEMMA_VISION_CLASSIFICATION_PROMPT}\n\nDocument text:\n{text_content}",
                            "stream": False,
                            "format": "json",
                            "keep_alive": "10m",
                            "options": {"temperature": 0.0, "num_predict": 100},
                        }
                        resp = await client.post(f"{base_url}/api/generate", json=payload)
                        if resp.status_code == 200:
                            raw_out = resp.json().get("response", "")
                            parsed = self._clean_and_parse_json(raw_out)
                except Exception as exc:
                    logger.error("Fallback text classifier also failed: %s", exc)
            else:
                raise MedGemmaUnavailableError(f"Medical validation model {model_name} unavailable and no fallback configured")

        if parsed:
            is_medical = bool(parsed.get("isMedical") or parsed.get("isMedicalDocument"))
            conf_val = parsed.get("confidence")
            try:
                confidence = float(conf_val) if conf_val is not None else (0.9 if is_medical else 0.8)
            except Exception:
                confidence = 0.5
            raw_doc_type = parsed.get("documentType")
            doc_type = self._normalize_document_type(raw_doc_type, is_medical)
            reason = parsed.get("reason")
        else:
            is_medical = False
            confidence = 0.0
            doc_type = None
            reason = "Failed to parse document classification output"

        elapsed = round(time.monotonic() - started, 3)

        logger.info(
            "medical_validation_completed",
            extra={
                "trace_id": trace,
                "is_medical": is_medical,
                "confidence": confidence,
                "document_type": doc_type,
                "elapsed_seconds": elapsed,
            },
        )

        return MedicalValidationResponse(
            isMedical=is_medical,
            confidence=confidence,
            documentType=doc_type,
            reason=reason,
            method=method,
            model=resolved_model,
            metrics=ValidationMetrics(
                processing_seconds=elapsed,
                pages_used=pages_used,
                used_ollama=True,
            ),
        )
