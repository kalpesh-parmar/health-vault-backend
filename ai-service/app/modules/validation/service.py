"""Medical Validation Service.

Validates uploaded clinical documents using local CPU encoder classifier (ekacare/med-doc-classifier).
Strictly decoupled from Ollama, generative LLMs, and document-type classification.
Always returns documentType = None for API contract compatibility.
"""
from __future__ import annotations

import io
import logging
import re
import time
from dataclasses import dataclass
from typing import Any

import fitz  # PyMuPDF
from PIL import Image

from app.api.v1.schemas.validation import MedicalValidationResponse, ValidationMetrics
from app.modules.validation.classifier import (
    ClassifierUnavailableError,
    MedicalDocumentClassifier,
    is_blank_page,
)
from app.settings import Settings

logger = logging.getLogger(__name__)

# Maintain MedGemmaUnavailableError as an alias for client & test compatibility
MedGemmaUnavailableError = ClassifierUnavailableError


class InvalidDocumentFileError(Exception):
    """Raised when document bytes cannot be parsed or read."""


# Preserved for backwards compatibility with any legacy imports/tests
ALLOWED_DOCUMENT_TYPES = {
    "PRESCRIPTION",
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
    "prescription": "PRESCRIPTION",
    "prescriptions": "PRESCRIPTION",
    "rx": "PRESCRIPTION",
    "lab": "LAB_REPORT",
    "lab report": "LAB_REPORT",
    "imaging": "IMAGING_REPORT",
    "x-ray": "IMAGING_REPORT",
    "mri": "IMAGING_REPORT",
    "ct": "IMAGING_REPORT",
    "ultrasound": "IMAGING_REPORT",
    "discharge": "DISCHARGE_SUMMARY",
    "consultation": "CONSULTATION_REPORT",
    "doctor note": "CONSULTATION_REPORT",
    "other medical document": "OTHER_MEDICAL_DOCUMENT",
}

CLINICAL_L2_KEYS = {
    "lab_diagnostic_report",
    "opd_consultation_record",
    "discharge_summary",
    "x_ray",
    "ct",
    "mri",
    "ultrasound",
    "scan_interpretation",
    "certificate",
    "skin_wound",
}

EXPLICIT_NON_MEDICAL_L2_KEYS = {
    "aadhaar_card",
    "pan_card",
    "voter_id",
    "other_card",
    "headshot",
}

ADVERTISEMENT_TRIGGERS = [
    "visit us at",
    "call toll free",
    "special discount",
    "sponsored by",
    "limited time offer",
    "contact sales",
    "advertisement",
    "call now",
    "flat discount",
    "buy 1 get 1",
    "offer valid till",
]

CLINICAL_METADATA_TRIGGERS = [
    "dr.",
    "doctor",
    "patient",
    "rx",
    "diagnosis",
    "dosage",
    "tablet",
    "capsule",
    "mg",
    "hospital",
    "clinic",
    "lab test",
]


@dataclass
class EvaluatedPage:
    page_number: int
    label: str  # "BLANK", "MEDICAL", "NON_MEDICAL", "ADVERTISEMENT", "UNKNOWN"
    p_medical: float
    l2_key: str
    p_good: float


class MedicalValidationService:
    def __init__(self, settings: Settings, storage: Any) -> None:
        self.settings = settings
        self.storage = storage

    def _get_classifier(self) -> MedicalDocumentClassifier:
        model_path = getattr(self.settings, "classifier_model_path", "models/med-doc-classifier")
        clf = MedicalDocumentClassifier.get_instance(model_path)
        if not clf.is_ready():
            clf.load(model_path)
        return clf

    def _validate_document_bytes(self, document_bytes: bytes, file_name: str | None = None) -> str:
        """Validate raw bytes in < 5ms before model invocation.

        Returns document format ('pdf' or 'image').
        Raises InvalidDocumentFileError for empty, corrupt, or unsupported data.
        """
        if not document_bytes or len(document_bytes) == 0:
            raise InvalidDocumentFileError("Uploaded file is empty")

        # Fast magic byte sniffing
        if document_bytes.startswith(b"%PDF"):
            return "pdf"
        if document_bytes.startswith(b"\xff\xd8\xff"):  # JPEG
            return "image"
        if document_bytes.startswith(b"\x89PNG\r\n\x1a\n"):  # PNG
            return "image"
        if document_bytes.startswith(b"RIFF") and len(document_bytes) >= 12 and document_bytes[8:12] == b"WEBP":
            return "image"
        if document_bytes.startswith(b"II*\x00") or document_bytes.startswith(b"MM\x00*"):  # TIFF
            return "image"

        # Check minimal size
        if len(document_bytes) < 16 and not (file_name and file_name.lower().endswith(".pdf")):
            raise InvalidDocumentFileError("Uploaded file is corrupted or too small (< 16 bytes)")

        # Fallback quick header probe via PIL or PyMuPDF
        try:
            with Image.open(io.BytesIO(document_bytes)) as img:
                img.verify()
                return "image"
        except Exception:
            pass

        try:
            with fitz.open(stream=document_bytes, filetype="pdf") as doc:
                if doc.page_count > 0:
                    return "pdf"
        except Exception:
            pass

        if file_name and file_name.lower().endswith(".pdf"):
            return "pdf"

        raise InvalidDocumentFileError("Unsupported or unreadable document format")

    def _select_pages_to_evaluate(self, total_pages: int, max_pages_cap: int = 5) -> list[int]:
        """[Deprecated] Retained for backwards compatibility with tests; not used in sequential traversal."""
        if total_pages <= 0:
            return []
        if total_pages <= 3:
            return list(range(total_pages))[:max_pages_cap]

        selected = [0, 1, 2, total_pages - 1]
        deduped = sorted(list(dict.fromkeys(selected)))
        return deduped[:max_pages_cap]

    async def _evaluate_single_page(
        self,
        image: Image.Image,
        page_number: int,
        page_text: str | None = None,
    ) -> EvaluatedPage:
        """Assign exact label to a single page."""
        # 1. Deterministic blank filter (< 2ms)
        if is_blank_page(image):
            return EvaluatedPage(
                page_number=page_number,
                label="BLANK",
                p_medical=0.0,
                l2_key="blank",
                p_good=0.0,
            )

        clf = self._get_classifier()
        result = await clf.classify_image(image)

        p_medical = float(result.get("p_medical", 0.0))
        l2_key = str(result.get("l2_key", "other_document"))
        p_good = float(result.get("p_good", 1.0))

        # 2. Advertisement check for digital PDFs (with text layer)
        if page_text and page_text.strip():
            lower_text = page_text.lower()
            has_ad_triggers = any(trigger in lower_text for trigger in ADVERTISEMENT_TRIGGERS)
            has_clinical = any(token in lower_text for token in CLINICAL_METADATA_TRIGGERS)
            if has_ad_triggers and not has_clinical:
                return EvaluatedPage(
                    page_number=page_number,
                    label="ADVERTISEMENT",
                    p_medical=0.0,
                    l2_key=l2_key,
                    p_good=p_good,
                )

        # 3. Explicit non-medical category guard (ID cards, credentials, headshots)
        # Evaluated before quality and medical criteria to prevent non-medical identity
        # documents from ever bypassing quality or achieving a medical classification.
        if l2_key in EXPLICIT_NON_MEDICAL_L2_KEYS:
            return EvaluatedPage(
                page_number=page_number,
                label="NON_MEDICAL",
                p_medical=p_medical,
                l2_key=l2_key,
                p_good=p_good,
            )

        # 4. Scanned / raster image without text layer: pharma flyer guard
        if not (page_text and page_text.strip()):
            if (l2_key in {"other_miscellaneous", "other_document", "medication_image"}) and p_medical < 0.50:
                return EvaluatedPage(
                    page_number=page_number,
                    label="NON_MEDICAL",
                    p_medical=p_medical,
                    l2_key=l2_key,
                    p_good=p_good,
                )

        # 5. Quality head degradation check (< 0.30)
        # Assigns UNKNOWN to low-quality images unless both independent heads
        # corroborate genuine clinical identity (P_medical >= 0.95 AND clinical L2).
        is_strong_clinical = (p_medical >= 0.95) and (l2_key in CLINICAL_L2_KEYS)
        if p_good < 0.30 and not is_strong_clinical:
            return EvaluatedPage(
                page_number=page_number,
                label="UNKNOWN",
                p_medical=p_medical,
                l2_key=l2_key,
                p_good=p_good,
            )

        # 6. Standard medical detection criteria
        if p_medical >= 0.60 or (p_medical >= 0.50 and l2_key in CLINICAL_L2_KEYS):
            label = "MEDICAL"
        elif p_medical < 0.40 or l2_key in EXPLICIT_NON_MEDICAL_L2_KEYS:
            label = "NON_MEDICAL"
        elif 0.40 <= p_medical < 0.60:
            label = "UNKNOWN"
        else:
            label = "NON_MEDICAL"

        return EvaluatedPage(
            page_number=page_number,
            label=label,
            p_medical=p_medical,
            l2_key=l2_key,
            p_good=p_good,
        )

    def _apply_ordered_decision_rules(self, pages: list[EvaluatedPage]) -> tuple[bool, float, str]:
        """Evaluate First-Match-Wins ordered document-level decision rules without majority voting or dilution."""
        active_pages = [p for p in pages if p.label != "BLANK"]
        n_active = len(active_pages)

        # Rule 1 [All Blank]
        if n_active == 0:
            return False, 0.99, "Document is empty or blank"

        # Positive medical determination: Any active page labeled MEDICAL immediately qualifies
        for p in active_pages:
            if p.label == "MEDICAL":
                return True, round(p.p_medical, 4), "Document contains verified clinical records"

        max_p_any = max((p.p_medical for p in active_pages), default=0.0)
        n_non_med = sum(1 for p in active_pages if p.label == "NON_MEDICAL")
        n_ad = sum(1 for p in active_pages if p.label == "ADVERTISEMENT")

        # Non-Medical rules (when zero medical pages exist)
        if n_ad == n_active:
            return False, round(1.0 - max_p_any, 4), "Document contains commercial advertisements or marketing flyers"
        if n_non_med == n_active or (n_ad + n_non_med) == n_active:
            return False, round(1.0 - max_p_any, 4), "Document does not contain clinical healthcare records"

        # Default fallback for UNKNOWN pages (fail-closed / low confidence)
        return False, round(1.0 - max_p_any, 4), "Unable to verify document authenticity with sufficient confidence"

    def _normalize_document_type(self, raw_type: str | None, is_medical: bool) -> str | None:
        """Maintained for backwards-compatibility; validation always yields documentType=None."""
        return None

    async def is_model_available(self, model_name: str | None = None) -> bool:
        """Check if local classifier is available."""
        try:
            clf = self._get_classifier()
            return clf.is_ready()
        except Exception:
            return False

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
        effective_filename = file_name or file_key or ""

        logger.info(
            "medical_validation_started",
            extra={"trace_id": trace, "file_key": effective_filename},
        )

        if file_bytes is not None:
            document_bytes = file_bytes
        else:
            if not file_key or not file_key.strip():
                raise InvalidDocumentFileError("fileKey is required when file_bytes is not provided")
            try:
                document_bytes = await self.storage.read_bytes(
                    bucket=bucket
                    or (
                        self.settings.aws_bucket_name
                        if self.settings.resolve_storage_provider() == "s3"
                        else self.settings.gcp_storage_bucket
                    ),
                    key=file_key,
                )
            except Exception as exc:
                logger.error(
                    "medical_validation_storage_read_failed",
                    extra={"trace_id": trace, "error": str(exc)},
                )
                raise InvalidDocumentFileError(f"Unable to read file from storage: {exc}") from exc

        if not document_bytes or len(document_bytes) == 0:
            raise InvalidDocumentFileError(
                "Uploaded file is empty" if file_bytes is not None else "File in storage is empty"
            )

        t_bytes_start = time.perf_counter()
        format_type = self._validate_document_bytes(document_bytes, effective_filename)
        print(f"  [PYTHON TIMING] _validate_document_bytes took {(time.perf_counter() - t_bytes_start)*1000:.2f}ms (format={format_type})", flush=True)

        is_pdf = (
            format_type == "pdf"
            or (mime_type and "pdf" in mime_type.lower())
            or effective_filename.lower().endswith(".pdf")
            or document_bytes.startswith(b"%PDF")
        )

        evaluated_pages: list[EvaluatedPage] = []
        is_medical: bool | None = None
        confidence: float = 0.0
        reason: str = ""

        if is_pdf:
            try:
                t_fitz_open = time.perf_counter()
                with fitz.open(stream=document_bytes, filetype="pdf") as doc:
                    print(f"  [PYTHON TIMING] fitz.open took {(time.perf_counter() - t_fitz_open)*1000:.2f}ms (total_pages={doc.page_count})", flush=True)
                    total_pages = doc.page_count
                    if total_pages == 0:
                        raise InvalidDocumentFileError("No usable pages extracted from PDF")

                    for p_idx in range(total_pages):
                        t_page_start = time.perf_counter()
                        page = doc.load_page(p_idx)
                        page_text = page.get_text()
                        t_pix_start = time.perf_counter()
                        pix = page.get_pixmap(dpi=150)
                        t_pix_elapsed = (time.perf_counter() - t_pix_start) * 1000
                        t_pil_start = time.perf_counter()
                        pil_img = Image.frombytes("RGB", [pix.width, pix.height], pix.samples)
                        del pix
                        t_pil_elapsed = (time.perf_counter() - t_pil_start) * 1000

                        t_eval_start = time.perf_counter()
                        ev_page = await self._evaluate_single_page(
                            image=pil_img,
                            page_number=p_idx + 1,
                            page_text=page_text,
                        )
                        t_eval_elapsed = (time.perf_counter() - t_eval_start) * 1000
                        t_page_total = (time.perf_counter() - t_page_start) * 1000
                        evaluated_pages.append(ev_page)

                        print(f"  [PYTHON TIMING] Page {p_idx+1}: pixmap(dpi=150)={t_pix_elapsed:.2f}ms, Image.frombytes={t_pil_elapsed:.2f}ms, eval={t_eval_elapsed:.2f}ms | Page Total={t_page_total:.2f}ms (label={ev_page.label}, p_med={ev_page.p_medical:.4f})", flush=True)

                        # Immediate positive early exit on first MEDICAL page
                        if ev_page.label == "MEDICAL":
                            logger.info(
                                "medical_validation_positive_early_exit",
                                extra={"trace_id": trace, "page": p_idx + 1, "p_medical": ev_page.p_medical},
                            )
                            is_medical = True
                            confidence = round(ev_page.p_medical, 4)
                            reason = "Document contains verified clinical records"
                            break
            except InvalidDocumentFileError:
                raise
            except ClassifierUnavailableError:
                raise
            except Exception as exc:
                logger.error("medical_validation_pdf_render_failed", extra={"trace_id": trace, "error": str(exc)})
                raise InvalidDocumentFileError(f"Failed to render PDF: {exc}") from exc
        else:
            try:
                with Image.open(io.BytesIO(document_bytes)) as raw_img:
                    raw_img.load()
                    pil_img = raw_img.convert("RGB")
                    ev_page = await self._evaluate_single_page(
                        image=pil_img,
                        page_number=1,
                        page_text=None,
                    )
                    evaluated_pages.append(ev_page)
                    if ev_page.label == "MEDICAL":
                        is_medical = True
                        confidence = round(ev_page.p_medical, 4)
                        reason = "Document contains verified clinical records"
            except ClassifierUnavailableError:
                raise
            except Exception as exc:
                logger.error("medical_validation_image_open_failed", extra={"trace_id": trace, "error": str(exc)})
                raise InvalidDocumentFileError(f"Failed to open image file: {exc}") from exc

        # If no page triggered positive early exit, resolve non-medical decision rules
        if is_medical is None:
            t_rules_start = time.perf_counter()
            is_medical, confidence, reason = self._apply_ordered_decision_rules(evaluated_pages)
            print(f"  [PYTHON TIMING] _apply_ordered_decision_rules took {(time.perf_counter() - t_rules_start)*1000:.2f}ms", flush=True)

        elapsed = round(time.monotonic() - started, 3)

        logger.info(
            "medical_validation_completed",
            extra={
                "trace_id": trace,
                "is_medical": is_medical,
                "confidence": confidence,
                "pages_used": len(evaluated_pages),
                "elapsed_seconds": elapsed,
            },
        )

        return MedicalValidationResponse(
            isMedical=is_medical,
            confidence=confidence,
            documentType=None,  # Always null for contract compatibility
            reason=reason,
            method="classifier",
            model="ekacare/med-doc-classifier",
            metrics=ValidationMetrics(
                processing_seconds=elapsed,
                pages_used=len(evaluated_pages),
                used_ollama=False,
            ),
        )
