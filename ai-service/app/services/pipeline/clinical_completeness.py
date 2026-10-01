from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)


def evaluate_heuristic_completeness(
    structured: dict[str, Any],
    raw_ocr_data: dict[str, Any],
    min_confidence_threshold: float = 0.85,
) -> dict[str, Any]:
    """
    Evaluates heuristic extraction completeness across core clinical fields (CLIN-01).
    Determines if structured extraction is rich enough to bypass the 16-18s medgemma:4b call (CLIN-02).

    Returns:
        dict containing:
            - completeness: float [0.0, 1.0]
            - ocr_confidence: float [0.0, 1.0]
            - confidence: float [0.0, 1.0]
            - bypass_eligible: bool
            - field_flags: dict[str, bool]
    """
    patient_info = structured.get("patientInfo") or {}
    provider_info = structured.get("providerInfo") or {}
    facility_info = structured.get("facilityInfo") or {}
    doc_info = structured.get("documentInfo") or {}
    medications = structured.get("medications") or []
    lab_results = structured.get("labResults") or []
    diagnoses = structured.get("diagnosis") or []
    vitals = structured.get("vitals") or []
    financial = structured.get("financialSummary") or {}

    primary_provider = provider_info.get("primary") or {}
    if not primary_provider and provider_info.get("providers"):
        primary_provider = provider_info["providers"][0]

    # 1. Patient Demographics (Weight 0.25)
    patient_name_val = (
        patient_info.get("fullName")
        or (patient_info.get("name", {}).get("full") if isinstance(patient_info.get("name"), dict) else patient_info.get("name"))
        or patient_info.get("firstName")
    )
    has_patient_name = bool(patient_name_val and len(str(patient_name_val).strip()) > 2)

    demographics = patient_info.get("demographics") if isinstance(patient_info.get("demographics"), dict) else {}
    has_patient_demographics = bool(
        patient_info.get("age") is not None
        or patient_info.get("gender")
        or demographics.get("age") is not None
        or demographics.get("gender")
    )
    patient_score = (0.20 if has_patient_name else 0.0) + (0.05 if has_patient_demographics else 0.0)

    # 2. Document Context & Provider/Facility (Weight 0.25)
    has_date = bool(doc_info.get("documentDate") or doc_info.get("date") or doc_info.get("rawDate"))
    has_provider = bool(primary_provider.get("name") and len(str(primary_provider.get("name")).strip()) > 3)
    has_facility = bool(facility_info.get("name") and len(str(facility_info.get("name")).strip()) > 3)
    has_provider_or_facility = has_provider or has_facility

    context_score = (0.10 if has_date else 0.0) + (0.15 if has_provider_or_facility else 0.0)

    # 3. Domain Entity Richness (Weight 0.40)
    doc_type = str(doc_info.get("documentType") or "").upper()

    has_valid_meds = any(
        isinstance(m, dict) and bool(m.get("name")) and len(str(m.get("name")).strip()) > 2
        for m in medications
    )
    has_valid_labs = any(
        isinstance(r, dict)
        and bool(r.get("testName") or r.get("canonicalKey") or r.get("parameter") or r.get("name"))
        and bool(str(r.get("value") or r.get("rawValue") or "").strip())
        for r in lab_results
    )
    has_valid_financial = bool(
        financial.get("lineItems")
        or financial.get("mandatoryTotal") is not None
        or financial.get("estimatedTotal") is not None
        or financial.get("totalAmount") is not None
    )
    has_valid_clinical = bool(diagnoses or vitals)

    entity_score = 0.0
    if doc_type == "LAB_REPORT":
        entity_score = 0.40 if has_valid_labs else (0.20 if has_valid_clinical else 0.0)
    elif doc_type == "PRESCRIPTION":
        entity_score = 0.40 if has_valid_meds else (0.20 if has_valid_clinical else 0.0)
    elif doc_type in ("QUOTATION", "INVOICE"):
        entity_score = 0.40 if has_valid_financial else (0.20 if has_provider_or_facility else 0.0)
    else:
        # General medical report / discharge summary
        if has_valid_meds or has_valid_labs:
            entity_score = 0.40
        elif len(diagnoses) >= 1 and len(vitals) >= 1:
            entity_score = 0.40
        elif diagnoses or vitals:
            entity_score = 0.30

    # 4. Classification Specificity (Weight 0.10)
    is_specific_type = doc_type in (
        "PRESCRIPTION",
        "LAB_REPORT",
        "DISCHARGE_SUMMARY",
        "DIAGNOSTIC_IMAGING",
        "QUOTATION",
        "INVOICE",
    )
    classification_score = 0.10 if is_specific_type else 0.05

    completeness = round(patient_score + context_score + entity_score + classification_score, 3)
    completeness = min(1.0, max(0.0, completeness))

    # Resolve OCR confidence
    raw_conf = (
        raw_ocr_data.get("confidence")
        or raw_ocr_data.get("mean_confidence")
        or (raw_ocr_data.get("metrics") or {}).get("mean_confidence")
    )
    if isinstance(raw_conf, (int, float)) and 0.0 <= raw_conf <= 1.0:
        ocr_confidence = round(float(raw_conf), 3)
    else:
        # Default fallback confidence if OCR confidence wasn't recorded directly
        ocr_confidence = 0.90 if len(raw_ocr_data.get("fullText") or "") > 50 else 0.70

    combined_confidence = round((0.50 * completeness) + (0.50 * ocr_confidence), 3)

    field_flags = {
        "has_patient_name": has_patient_name,
        "has_patient_demographics": has_patient_demographics,
        "has_date": has_date,
        "has_provider_or_facility": has_provider_or_facility,
        "has_medications": has_valid_meds,
        "has_lab_results": has_valid_labs,
        "has_clinical_entities": has_valid_clinical or has_valid_financial,
        "is_specific_type": is_specific_type,
    }

    meets_confidence_threshold = bool(
        ocr_confidence >= min_confidence_threshold
        and combined_confidence >= min_confidence_threshold
    )

    # Bypass requires:
    # 1. Completeness >= 0.75 (core patient and domain entities detected)
    # 2. Both OCR confidence and Combined confidence >= threshold (default 0.85)
    # 3. Non-empty text
    full_text_chars = len((raw_ocr_data.get("fullText") or "").strip())
    bypass_eligible = bool(
        completeness >= 0.75
        and meets_confidence_threshold
        and full_text_chars > 20
    )

    return {
        "completeness": completeness,
        "ocr_confidence": ocr_confidence,
        "confidence": combined_confidence,
        "bypass_eligible": bypass_eligible,
        "field_flags": field_flags,
        "details": {
            "patient_score": patient_score,
            "context_score": context_score,
            "entity_score": entity_score,
            "classification_score": classification_score,
            "field_flags": field_flags,
            "meets_confidence_threshold": meets_confidence_threshold,
        },
    }
