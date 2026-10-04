from __future__ import annotations

import time
import pytest
from unittest.mock import AsyncMock, MagicMock

from app.services.pipeline.clinical_stage import ClinicalStageHandler
from app.services.pipeline.clinical_completeness import evaluate_heuristic_completeness


def test_heuristic_completeness_scoring_clean_prescription():
    structured = {
        "documentInfo": {"documentType": "PRESCRIPTION", "date": "2024-03-15"},
        "patientInfo": {
            "name": {"full": "Rajesh Kumar"},
            "demographics": {"age": 42, "gender": "MALE"},
        },
        "providerInfo": {
            "primary": {"name": "Dr. Ramesh Patel", "role": "Physician"}
        },
        "facilityInfo": {"name": "Apollo Clinic"},
        "medications": [
            {"name": "Metformin", "dosage": "500mg", "frequency": "BID"},
            {"name": "Glimepiride", "dosage": "1mg", "frequency": "OD"},
        ],
        "diagnosis": [{"condition": "Type 2 Diabetes Mellitus"}],
    }
    raw_ocr = {
        "confidence": 0.92,
        "ocr_confidence": 0.92,
        "fullText": "Apollo Clinic\nDr. Ramesh Patel\nPatient: Rajesh Kumar\n...",
    }

    res = evaluate_heuristic_completeness(structured, raw_ocr, min_confidence_threshold=0.85)

    assert res["completeness"] >= 0.75
    assert res["bypass_eligible"] is True
    assert res["details"]["field_flags"]["has_patient_name"] is True
    assert res["details"]["field_flags"]["has_provider_or_facility"] is True
    assert res["details"]["field_flags"]["has_medications"] is True
    assert res["confidence"] >= 0.85


def test_heuristic_completeness_scoring_clean_lab_report():
    structured = {
        "documentInfo": {"documentType": "LAB_REPORT", "date": "2024-01-20"},
        "patientInfo": {
            "name": {"full": "Anil Deshmukh"},
            "demographics": {"age": 55, "gender": "MALE"},
        },
        "providerInfo": {
            "primary": {"name": "Dr. S. K. Gupta"}
        },
        "facilityInfo": {"name": "Dr Lal PathLabs"},
        "labResults": [
            {"canonicalKey": "fasting_blood_sugar", "value": 110.0, "unit": "mg/dL"},
            {"canonicalKey": "hba1c", "value": 6.8, "unit": "%"},
        ],
        "diagnosis": [],
        "medications": [],
    }
    raw_ocr = {
        "confidence": 0.95,
        "ocr_confidence": 0.95,
        "fullText": "Dr Lal PathLabs\nPatient: Anil Deshmukh\n...",
    }

    res = evaluate_heuristic_completeness(structured, raw_ocr, min_confidence_threshold=0.85)

    assert res["completeness"] >= 0.75
    assert res["bypass_eligible"] is True
    assert res["details"]["field_flags"]["has_lab_results"] is True


def test_heuristic_completeness_degraded_prescription_ineligible():
    # Missing patient name, missing provider, low confidence
    structured = {
        "documentInfo": {"documentType": "UNKNOWN", "date": None},
        "patientInfo": {"name": {"full": None}, "demographics": {}},
        "providerInfo": {},
        "facilityInfo": {},
        "medications": [],
        "diagnosis": [],
        "labResults": [],
    }
    raw_ocr = {
        "confidence": 0.65,
        "ocr_confidence": 0.65,
        "fullText": "Tab Paracetamol 500mg TDS",
    }

    res = evaluate_heuristic_completeness(structured, raw_ocr, min_confidence_threshold=0.85)

    assert res["completeness"] < 0.50
    assert res["bypass_eligible"] is False


def test_heuristic_completeness_low_confidence_blocks_bypass():
    # Complete document but low confidence
    structured = {
        "documentInfo": {"documentType": "PRESCRIPTION", "date": "2024-03-15"},
        "patientInfo": {
            "name": {"full": "Rajesh Kumar"},
            "demographics": {"age": 42, "gender": "MALE"},
        },
        "providerInfo": {"primary": {"name": "Dr. Ramesh Patel"}},
        "facilityInfo": {"name": "Apollo Clinic"},
        "medications": [{"name": "Metformin", "dosage": "500mg"}],
        "diagnosis": [{"condition": "Diabetes"}],
    }
    raw_ocr = {
        "confidence": 0.72,
        "ocr_confidence": 0.72,
        "fullText": "...",
    }

    res = evaluate_heuristic_completeness(structured, raw_ocr, min_confidence_threshold=0.85)

    # Even if completeness is decent, eligible must be False due to confidence < 0.85
    assert res["bypass_eligible"] is False
    assert res["details"]["meets_confidence_threshold"] is False


@pytest.mark.asyncio
async def test_fastpath_heuristic_bypass_skips_ai_extraction():
    mock_extraction = MagicMock()
    mock_extraction.normalize_structured_ocr = AsyncMock()

    handler = ClinicalStageHandler(
        extraction_service=mock_extraction,
        bypass_min_confidence=0.85,
    )

    clean_ocr = {
        "confidence": 0.94,
        "ocr_confidence": 0.94,
        "fullText": (
            "CITY HOSPITAL\n"
            "Dr. Vikram Singh MD\n"
            "Date: 12/04/2024\n"
            "Patient Name: Priya Sharma  Age: 32 Yrs  Gender: Female\n"
            "Diagnosis: Acute Bronchitis\n"
            "Rx:\n"
            "Tab Azithromycin 500mg - 1 OD x 3 days\n"
            "Syp Ambroxol 15ml - TDS\n"
        ),
        "paragraphs": [],
    }

    t0 = time.monotonic()
    result = await handler.extract_fields(clean_ocr)
    latency_ms = (time.monotonic() - t0) * 1000

    # Verification: AI extraction service must NOT be called
    mock_extraction.normalize_structured_ocr.assert_not_called()

    # Latency must be extremely fast (< 50ms)
    assert latency_ms < 50.0

    # Path must be tagged as heuristic_bypass
    assert result["additionalInformation"]["extractionPath"] == "heuristic_bypass"
    assert result["additionalInformation"]["heuristicBypassEligible"] is True
    assert result["additionalInformation"]["completenessScore"] >= 0.75

    # Entity verification
    assert result["patientInfo"]["fullName"] == "Priya Sharma"
    assert len(result["medications"]) >= 2
    assert "Vikram Singh" in result["providerInfo"]["primary"]["name"]


@pytest.mark.asyncio
async def test_fallback_to_ai_normalization_when_ineligible():
    mock_extraction = MagicMock()
    mock_extraction.normalize_structured_ocr = AsyncMock(
        return_value={
            "documentInfo": {"documentType": "PRESCRIPTION"},
            "patientInfo": {"fullName": "Recovered Patient"},
            "diagnosis": [{"condition": "Recovered Diagnosis"}],
            "medications": [{"name": "Recovered Drug", "dosage": "10mg"}],
        }
    )

    handler = ClinicalStageHandler(
        extraction_service=mock_extraction,
        bypass_min_confidence=0.85,
    )

    # Incomplete degraded text with low confidence
    degraded_ocr = {
        "confidence": 0.60,
        "ocr_confidence": 0.60,
        "fullText": "Rx blurry text ...",
        "paragraphs": [],
    }

    result = await handler.extract_fields(degraded_ocr)

    # AI normalization must have been called
    mock_extraction.normalize_structured_ocr.assert_called_once()
    assert result["additionalInformation"]["extractionPath"] == "ai_normalized"
    assert result["additionalInformation"]["heuristicBypassEligible"] is False
    assert result["patientInfo"]["fullName"] == "Recovered Patient"


@pytest.mark.asyncio
async def test_vlm_schema_consolidation_skips_ai_extraction():
    mock_extraction = MagicMock()
    mock_extraction.normalize_structured_ocr = AsyncMock()

    handler = ClinicalStageHandler(
        extraction_service=mock_extraction,
        bypass_min_confidence=0.85,
    )

    vlm_ocr = {
        "engine": "vlm_fallback",
        "confidence": 0.91,
        "ocr_confidence": 0.91,
        "fullText": "Hospital receipt text...",
        "medicalExtraction": {
            "documentType": "DISCHARGE_SUMMARY",
            "patientName": "Sunita Verma",
            "patientAge": 58,
            "patientGender": "Female",
            "documentDate": "2024-02-18",
            "doctorName": "Dr. K. L. Rao",
            "hospitalName": "Max Healthcare",
            "diagnoses": ["Unstable Angina", "Hypertension"],
            "medications": [
                {"name": "Tab Clopidogrel", "dosage": "75mg", "frequency": "OD"},
                {"name": "Tab Rosuvastatin", "dosage": "20mg", "frequency": "HS"},
            ],
            "labResults": [
                {"testName": "Troponin I", "value": "0.02", "unit": "ng/mL", "flag": "NORMAL"},
            ],
            "vitalSigns": {
                "bloodPressure": "130/80 mmHg",
                "heartRate": "72 bpm",
            },
            "procedures": [{"name": "Coronary Angiography", "date": "2024-02-17"}],
            "financialSummary": {
                "totalAmount": 125000.0,
                "paidAmount": 125000.0,
                "dueAmount": 0.0,
            },
        },
    }

    t0 = time.monotonic()
    result = await handler.extract_fields(vlm_ocr)
    latency_ms = (time.monotonic() - t0) * 1000

    # Verification: AI extraction service must NOT be called
    mock_extraction.normalize_structured_ocr.assert_not_called()

    # Fast execution (< 50ms)
    assert latency_ms < 50.0

    # Path must be tagged as vlm_consolidated
    assert result["additionalInformation"]["extractionPath"] == "vlm_consolidated"
    assert result["additionalInformation"]["sourceEngine"] == "vlm_fallback"

    # Schema conformance verification
    assert result["documentInfo"]["documentType"] == "DISCHARGE_SUMMARY"
    assert result["patientInfo"]["fullName"] == "Sunita Verma"
    assert result["patientInfo"]["age"] == 58
    assert result["patientInfo"]["gender"] == "FEMALE"
    assert result["providerInfo"]["primary"]["name"] == "Dr. K. L. Rao"
    assert result["facilityInfo"]["name"] == "Max Healthcare"

    assert len(result["diagnosis"]) == 2
    assert len(result["medications"]) == 2
    assert len(result["labResults"]) == 1
    assert result["labResults"][0]["testName"] == "Troponin I"
    assert len(result["procedures"]) == 1
    assert result["financialSummary"]["totalAmount"] == 125000.0


@pytest.mark.asyncio
async def test_quotation_invariant_enforced_in_fastpath():
    handler = ClinicalStageHandler(extraction_service=None)

    quotation_ocr = {
        "confidence": 0.95,
        "ocr_confidence": 0.95,
        "fullText": (
            "SHREE DENTAL CLINIC\n"
            "ESTIMATED QUOTATION\n"
            "Patient: Manjulaben Ranoliya  Age: 52  Female\n"
            "Dr. Milan Patel BDS, MDS\n"
            "Date: 10/01/2024\n"
            "Treatment: Full Mouth Dental Implants\n"
            "Amount: Rs. 1,45,000\n"
        ),
        "tables": [
            {
                "headers": ["Item", "Qty", "Rate", "Total"],
                "rows": [["Dental Implant Titanium", "4", "25000", "100000"]],
            }
        ],
    }

    result = await handler.extract_fields(quotation_ocr)

    assert "QUOTATION" in result["documentInfo"]["documentType"].upper()
    # Invariant: No clinical hallucinations for quotations
    assert result["diagnosis"] == []
    assert result["medications"] == []
    assert result["labResults"] == []
    assert result["vitals"] == []
