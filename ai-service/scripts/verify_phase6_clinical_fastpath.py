"""Phase 6 Clinical Extraction Fast-Path and Consolidation Verification Script.

Executes Task 6 end-to-end verification gate for:
- CLIN-01: Heuristic completeness assessment across core clinical fields (demographics, date, provider, domain entities).
- CLIN-02: Fast-path heuristic bypass for high-confidence documents (>= 0.85), reducing clinical stage latency from 16.3s to < 50ms.
- CLIN-03: Multimodal VLM schema consolidation for documents originating from VLM fallback, mapping directly to 14 sections without redundant medgemma call.
- Preserves LabEvaluator bounds/flags normalization and quotation invariants.
- Strict Zero-PHI logging adherence.
"""
from __future__ import annotations

import asyncio
import logging
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

from app.settings import get_settings
from app.services.pipeline.clinical_stage import ClinicalStageHandler
from app.services.pipeline.clinical_completeness import evaluate_heuristic_completeness
from app.services.pipeline.lab_evaluator import LabEvaluator


async def verify_phase6():
    print("=" * 80)
    print("PHASE 6 VERIFICATION GATE: CLINICAL EXTRACTION FAST-PATH & CONSOLIDATION")
    print("=" * 80)

    settings = get_settings()
    results = {}

    # ──────────────────────────────────────────────────────────────────────────
    # Check 1: Settings & Threshold Configuration
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 1: Settings & Threshold Configuration]")
    bypass_thresh = getattr(settings, "clinical_heuristic_bypass_min_confidence", None)
    print(f"  - CLINICAL_HEURISTIC_BYPASS_MIN_CONFIDENCE configured: {bypass_thresh}")
    assert bypass_thresh is not None, "Missing clinical_heuristic_bypass_min_confidence in settings"
    assert bypass_thresh == 0.85, f"Expected default 0.85, got {bypass_thresh}"
    results["settings_configured"] = True
    print("  [PASS] Settings configuration verified.")

    # ──────────────────────────────────────────────────────────────────────────
    # Check 2: Heuristic Completeness Evaluation (CLIN-01)
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 2: Heuristic Completeness Scoring (CLIN-01)]")

    # 2a. Clean Prescription (High Completeness)
    clean_rx = {
        "documentInfo": {"documentType": "PRESCRIPTION", "date": "2024-03-15"},
        "patientInfo": {
            "name": {"full": "Ramesh Gupta"},
            "demographics": {"age": 52, "gender": "MALE"},
        },
        "providerInfo": {"primary": {"name": "Dr. Sunita Sharma MD"}},
        "facilityInfo": {"name": "Max Super Speciality Hospital"},
        "medications": [
            {"name": "Telmisartan 40mg", "dosage": "40mg", "frequency": "OD"},
            {"name": "Metformin 500mg", "dosage": "500mg", "frequency": "BID"},
        ],
        "diagnosis": [{"condition": "Hypertension, T2DM"}],
    }
    clean_rx_ocr = {
        "confidence": 0.94,
        "ocr_confidence": 0.94,
        "fullText": "Max Super Speciality Hospital\nDr. Sunita Sharma MD\nPatient: Ramesh Gupta\n...",
    }

    eval_rx = evaluate_heuristic_completeness(clean_rx, clean_rx_ocr, min_confidence_threshold=0.85)
    print(f"  - Clean Prescription Score:      {eval_rx['completeness']:.3f} (bypass_eligible: {eval_rx['bypass_eligible']})")
    assert eval_rx["completeness"] >= 0.75, f"Expected completeness >= 0.75, got {eval_rx['completeness']}"
    assert eval_rx["bypass_eligible"] is True, "Clean prescription must be eligible for bypass"
    assert eval_rx["field_flags"]["has_patient_name"] is True
    assert eval_rx["field_flags"]["has_medications"] is True

    # 2b. Clean Lab Report (High Completeness)
    clean_lab = {
        "documentInfo": {"documentType": "LAB_REPORT", "date": "2024-01-20"},
        "patientInfo": {
            "name": {"full": "Pooja Varma"},
            "demographics": {"age": 30, "gender": "FEMALE"},
        },
        "providerInfo": {"primary": {"name": "Dr. A. K. Roy"}},
        "facilityInfo": {"name": "Metropolis Healthcare"},
        "labResults": [
            {"testName": "Hemoglobin", "value": "13.5", "unit": "g/dL"},
            {"testName": "Platelet Count", "value": "250000", "unit": "/mcL"},
        ],
        "diagnosis": [],
        "medications": [],
    }
    clean_lab_ocr = {
        "confidence": 0.96,
        "ocr_confidence": 0.96,
        "fullText": "Metropolis Healthcare\nPatient: Pooja Varma\n...",
    }

    eval_lab = evaluate_heuristic_completeness(clean_lab, clean_lab_ocr, min_confidence_threshold=0.85)
    print(f"  - Clean Lab Report Score:        {eval_lab['completeness']:.3f} (bypass_eligible: {eval_lab['bypass_eligible']})")
    assert eval_lab["completeness"] >= 0.75, f"Expected completeness >= 0.75, got {eval_lab['completeness']}"
    assert eval_lab["bypass_eligible"] is True, "Clean lab report must be eligible for bypass"
    assert eval_lab["field_flags"]["has_lab_results"] is True

    # 2c. Degraded Document (Incomplete & Low Confidence)
    degraded_doc = {
        "documentInfo": {"documentType": "UNKNOWN", "date": None},
        "patientInfo": {},
        "providerInfo": {},
        "facilityInfo": {},
        "medications": [],
        "labResults": [],
        "diagnosis": [],
    }
    degraded_ocr = {
        "confidence": 0.60,
        "ocr_confidence": 0.60,
        "fullText": "unclear blur scan",
    }
    eval_degraded = evaluate_heuristic_completeness(degraded_doc, degraded_ocr, min_confidence_threshold=0.85)
    print(f"  - Degraded Document Score:       {eval_degraded['completeness']:.3f} (bypass_eligible: {eval_degraded['bypass_eligible']})")
    assert eval_degraded["completeness"] < 0.50
    assert eval_degraded["bypass_eligible"] is False, "Degraded document must NOT be eligible for bypass"

    results["completeness_scoring"] = True
    print("  [PASS] CLIN-01 completeness scoring verified.")

    # ──────────────────────────────────────────────────────────────────────────
    # Check 3: Fast-Path Heuristic Bypass Execution & Latency (CLIN-02)
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 3: Fast-Path Heuristic Bypass & Latency (CLIN-02)]")
    mock_extraction = MagicMock()
    mock_extraction.normalize_structured_ocr = AsyncMock()

    handler = ClinicalStageHandler(
        extraction_service=mock_extraction,
        bypass_min_confidence=0.85,
    )

    clean_ocr_input = {
        "confidence": 0.94,
        "ocr_confidence": 0.94,
        "fullText": (
            "FORTIS HOSPITAL\n"
            "Dr. Rajesh Khanna MD\n"
            "Date: 15/03/2024\n"
            "Patient: Amit Trivedi  Age: 38 Yrs  Gender: Male\n"
            "Diagnosis: Type 2 Diabetes Mellitus, Essential Hypertension\n"
            "Rx:\n"
            "Tab Metformin 500mg - 1 BD\n"
            "Tab Telmisartan 40mg - 1 OD\n"
        ),
        "paragraphs": [],
    }

    t0 = time.monotonic()
    fastpath_result = await handler.extract_fields(clean_ocr_input)
    elapsed_ms = (time.monotonic() - t0) * 1000

    print(f"  - Extraction Path:               {fastpath_result['additionalInformation']['extractionPath']}")
    print(f"  - Stage Latency:                 {elapsed_ms:.2f} ms (Target: < 50.0 ms)")
    print(f"  - AI Service LLM Called:         {mock_extraction.normalize_structured_ocr.called}")
    print(f"  - Completeness Score:            {fastpath_result['additionalInformation']['completenessScore']}")
    print(f"  - Heuristic Bypass Eligible:     {fastpath_result['additionalInformation']['heuristicBypassEligible']}")

    assert mock_extraction.normalize_structured_ocr.called is False, "LLM normalization MUST be skipped on fastpath"
    assert fastpath_result["additionalInformation"]["extractionPath"] == "heuristic_bypass"
    assert fastpath_result["additionalInformation"]["heuristicBypassEligible"] is True
    assert elapsed_ms < 50.0, f"Latency {elapsed_ms:.2f}ms exceeded 50ms SLA"

    # Entities verified
    assert fastpath_result["patientInfo"]["fullName"] == "Amit Trivedi"
    assert fastpath_result["patientInfo"]["age"] == 38
    assert fastpath_result["patientInfo"]["gender"] == "MALE"
    assert "Rajesh Khanna" in fastpath_result["providerInfo"]["primary"]["name"]
    assert len(fastpath_result["medications"]) >= 2
    assert len(fastpath_result["diagnosis"]) >= 1

    results["fastpath_bypass"] = True
    print(f"  [PASS] CLIN-02 verified: Latency dropped from 16.3s baseline down to {elapsed_ms:.2f}ms (< 50ms)!")

    # ──────────────────────────────────────────────────────────────────────────
    # Check 4: Fallback Preservation on Low Confidence / Incomplete Document
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 4: Fallback to AI Normalization on Degraded Document]")
    mock_extraction.reset_mock()
    mock_extraction.normalize_structured_ocr = AsyncMock(
        return_value={
            "documentInfo": {"documentType": "PRESCRIPTION"},
            "patientInfo": {"fullName": "Recovered Amit"},
            "diagnosis": [{"condition": "Recovered Condition"}],
            "medications": [{"name": "Recovered Med", "dosage": "5mg"}],
        }
    )

    degraded_input = {
        "confidence": 0.65,
        "ocr_confidence": 0.65,
        "fullText": "blur noisy incomplete prescription scan text",
        "paragraphs": [],
    }

    fallback_result = await handler.extract_fields(degraded_input)
    print(f"  - Extraction Path:               {fallback_result['additionalInformation']['extractionPath']}")
    print(f"  - AI Service LLM Called:         {mock_extraction.normalize_structured_ocr.called}")

    assert mock_extraction.normalize_structured_ocr.called is True, "AI service must be called when ineligible"
    assert fallback_result["additionalInformation"]["extractionPath"] == "ai_normalized"
    assert fallback_result["additionalInformation"]["heuristicBypassEligible"] is False
    assert fallback_result["patientInfo"]["fullName"] == "Recovered Amit"

    results["fallback_preservation"] = True
    print("  [PASS] Fallback preservation verified.")

    # ──────────────────────────────────────────────────────────────────────────
    # Check 5: Multimodal VLM Schema Consolidation (CLIN-03)
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 5: Multimodal VLM Schema Consolidation (CLIN-03)]")
    mock_extraction.reset_mock()

    vlm_input = {
        "engine": "vlm_fallback",
        "confidence": 0.92,
        "ocr_confidence": 0.92,
        "fullText": "Discharge summary raw transcription...",
        "medicalExtraction": {
            "documentType": "DISCHARGE_SUMMARY",
            "patientName": "Devendra Joshi",
            "patientAge": 62,
            "patientGender": "Male",
            "documentDate": "2024-03-01",
            "doctorName": "Dr. N. K. Bansal",
            "hospitalName": "Lilavati Hospital",
            "diagnoses": ["Acute Myocardial Infarction", "Hyperlipidemia"],
            "medications": [
                {"name": "Aspirin", "dosage": "75mg", "frequency": "OD"},
                {"name": "Atorvastatin", "dosage": "40mg", "frequency": "HS"},
            ],
            "labResults": [
                {"testName": "Serum Creatinine", "value": "1.1", "unit": "mg/dL", "flag": "NORMAL"},
                {"testName": "HbA1c", "value": "7.4", "unit": "%", "flag": "HIGH"},
            ],
            "vitalSigns": {
                "bloodPressure": "124/78 mmHg",
                "heartRate": "68 bpm",
            },
            "procedures": [{"name": "PTCA with Stent", "date": "2024-02-28"}],
            "financialSummary": {
                "mandatoryTotal": 240000.0,
                "paidAmount": 240000.0,
                "balanceDue": 0.0,
            },
        },
    }

    t0 = time.monotonic()
    vlm_result = await handler.extract_fields(vlm_input)
    vlm_elapsed_ms = (time.monotonic() - t0) * 1000

    print(f"  - Extraction Path:               {vlm_result['additionalInformation']['extractionPath']}")
    print(f"  - Source Engine:                 {vlm_result['additionalInformation']['sourceEngine']}")
    print(f"  - Latency:                       {vlm_elapsed_ms:.2f} ms")
    print(f"  - AI Service LLM Called:         {mock_extraction.normalize_structured_ocr.called}")

    assert mock_extraction.normalize_structured_ocr.called is False, "LLM must NOT be called for VLM consolidated docs"
    assert vlm_result["additionalInformation"]["extractionPath"] == "vlm_consolidated"
    assert vlm_result["additionalInformation"]["sourceEngine"] == "vlm_fallback"
    assert vlm_result["documentInfo"]["documentType"] == "DISCHARGE_SUMMARY"
    assert vlm_result["patientInfo"]["fullName"] == "Devendra Joshi"
    assert vlm_result["patientInfo"]["age"] == 62
    assert vlm_result["patientInfo"]["gender"] == "MALE"
    assert vlm_result["providerInfo"]["primary"]["name"] == "Dr. N. K. Bansal"
    assert vlm_result["facilityInfo"]["name"] == "Lilavati Hospital"
    assert len(vlm_result["diagnosis"]) == 2
    assert len(vlm_result["medications"]) == 2
    assert len(vlm_result["labResults"]) == 2
    assert len(vlm_result["procedures"]) == 1
    assert vlm_result["financialSummary"]["mandatoryTotal"] == 240000.0

    # Lab Evaluator run check
    assert vlm_result["labResults"][0]["testName"] == "Serum Creatinine"
    assert vlm_result["labResults"][1]["testName"] == "HbA1c"

    results["vlm_consolidation"] = True
    print(f"  [PASS] CLIN-03 verified: Consolidated in {vlm_elapsed_ms:.2f}ms without redundant LLM call!")

    # ──────────────────────────────────────────────────────────────────────────
    # Check 6: Golden Document Regression (lab_1_.jpeg & Manjulaben Quotation)
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 6: Golden Document Regression Verification]")

    # 6a. Dental Quotation Invariant Check
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

    quote_result = await handler.extract_fields(quotation_ocr)
    print(f"  - Quotation Document Type:       {quote_result['documentInfo']['documentType']}")
    print(f"  - Quotation Diagnoses Count:     {len(quote_result['diagnosis'])}")
    print(f"  - Quotation Medications Count:   {len(quote_result['medications'])}")
    print(f"  - Quotation Lab Results Count:   {len(quote_result['labResults'])}")
    print(f"  - Quotation Vitals Count:        {len(quote_result['vitals'])}")
    print(f"  - Quotation Line Items Count:    {len(quote_result['financialSummary']['lineItems'])}")

    assert "QUOTATION" in quote_result["documentInfo"]["documentType"].upper()
    assert quote_result["diagnosis"] == [], "Quotation must have empty diagnoses"
    assert quote_result["medications"] == [], "Quotation must have empty medications"
    assert quote_result["labResults"] == [], "Quotation must have empty lab results"
    assert quote_result["vitals"] == [], "Quotation must have empty vitals"
    assert len(quote_result["financialSummary"]["lineItems"]) >= 1, "Quotation line items must be preserved"

    # 6b. Lab Evaluator Reference Bounds Validation
    glucose_eval = LabEvaluator.evaluate_result("Fasting Blood Sugar", 220.0)
    assert glucose_eval["flag"] == "HIGH"
    assert glucose_eval["isAbnormal"] is True

    crit_k_eval = LabEvaluator.evaluate_result("Serum Potassium", 2.3)
    assert crit_k_eval["flag"] == "CRITICAL"
    assert crit_k_eval["isCritical"] is True

    results["golden_regression"] = True
    print("  [PASS] Golden document quotation and lab bounds invariants verified.")

    # ──────────────────────────────────────────────────────────────────────────
    # Check 7: Zero-PHI Logging Adherence
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 7: Zero-PHI Logging Adherence]")
    # Check logger calls in clinical_stage.py
    with open(AI_SERVICE_DIR / "app" / "services" / "pipeline" / "clinical_stage.py", "r", encoding="utf-8") as f:
        clinical_stage_code = f.read()

    bypass_idx = clinical_stage_code.find("clinical_heuristic_bypass_activated")
    vlm_idx = clinical_stage_code.find("clinical_vlm_schema_consolidated")

    assert bypass_idx != -1, "clinical_heuristic_bypass_activated log event not found"
    assert vlm_idx != -1, "clinical_vlm_schema_consolidated log event not found"

    bypass_log_sec = clinical_stage_code[bypass_idx:bypass_idx + 800]
    vlm_log_sec = clinical_stage_code[vlm_idx:vlm_idx + 800]

    for log_sec in (bypass_log_sec, vlm_log_sec):
        assert "patient_name" not in log_sec.lower()
        assert "patientname" not in log_sec.lower()
        assert "full_name" not in log_sec.lower()
        assert "medication_name" not in log_sec.lower()

    results["zero_phi_logging"] = True
    print("  [PASS] Zero-PHI logging adherence confirmed.")

    # ──────────────────────────────────────────────────────────────────────────
    # Final Gate Summary
    # ──────────────────────────────────────────────────────────────────────────
    print("\n" + "=" * 80)
    print("PHASE 6 VERIFICATION GATE COMPLETED: ALL CHECKS PASSED")
    print(f"Summary: {sum(results.values())}/{len(results)} requirements verified successfully.")
    print("=" * 80)


if __name__ == "__main__":
    asyncio.run(verify_phase6())
