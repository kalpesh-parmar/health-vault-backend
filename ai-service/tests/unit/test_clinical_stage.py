from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.services.pipeline.analysis_stage import AnalysisStageHandler
from app.services.pipeline.clinical_stage import ClinicalStageHandler
from app.services.pipeline.lab_evaluator import LabEvaluator


def test_lab_evaluator_assigns_correct_bounds_flags():
    # Normal glucose
    res_normal = LabEvaluator.evaluate_result("Fasting Blood Sugar", 85.0)
    assert res_normal["flag"] == "NORMAL"
    assert res_normal["isAbnormal"] is False
    assert res_normal["isCritical"] is False

    # High HbA1c
    res_high = LabEvaluator.evaluate_result("HbA1c", 8.2)
    assert res_high["flag"] == "HIGH"
    assert res_high["isAbnormal"] is True
    assert res_high["isCritical"] is False

    # Low Potassium
    res_low = LabEvaluator.evaluate_result("Serum Potassium", 3.1)
    assert res_low["flag"] == "LOW"
    assert res_low["isAbnormal"] is True

    # Critical Potassium (< 2.8)
    res_crit_potassium = LabEvaluator.evaluate_result("Serum Potassium", 2.4)
    assert res_crit_potassium["flag"] == "CRITICAL"
    assert res_crit_potassium["isCritical"] is True

    # Critical Glucose (> 300)
    res_crit_glucose = LabEvaluator.evaluate_result("Fasting Glucose", 340.0)
    assert res_crit_glucose["flag"] == "CRITICAL"
    assert res_crit_glucose["isCritical"] is True


@pytest.mark.asyncio
async def test_clinical_extraction_schema_conformance():
    handler = ClinicalStageHandler(extraction_service=None)
    raw_ocr = {
        "fullText": (
            "APOLLO CLINIC\n"
            "Patient Name: Rahul Sharma  Age: 45 Yrs  Gender: Male\n"
            "Dr. Anjali Mehta MD\n"
            "Diagnosis: Essential Hypertension, Dyslipidemia\n"
            "Rx:\n"
            "Tab Telmisartan 40mg - Once daily\n"
            "Tab Atorvastatin 10mg - At bedtime\n"
            "BP: 145/92 mmHg  Pulse: 78 bpm\n"
        ),
        "paragraphs": [],
    }
    layout = {
        "tables": [
            {
                "headers": ["Investigation", "Value", "Unit"],
                "rows": [["Total Cholesterol", "220", "mg/dL"], ["HDL", "35", "mg/dL"]],
            }
        ],
        "signatures": [{"text": "Dr. Anjali Mehta MD"}],
    }

    structured = await handler.extract_fields(raw_ocr, layout)

    assert structured["patientInfo"]["fullName"] == "Rahul Sharma"
    assert structured["patientInfo"]["age"] == 45
    assert structured["patientInfo"]["gender"] == "MALE"
    assert "Anjali Mehta" in structured["providerInfo"]["primary"]["name"]

    assert len(structured["diagnosis"]) >= 1
    assert any("Hypertension" in (d.get("condition") if isinstance(d, dict) else d) for d in structured["diagnosis"])

    assert len(structured["medications"]) == 2
    assert structured["medications"][0]["dosage"] == "40mg"

    assert len(structured["labResults"]) == 2
    assert structured["labResults"][0]["canonicalKey"] == "total_cholesterol"
    assert structured["labResults"][0]["flag"] == "HIGH"


def test_vitals_extraction_and_anomaly_detection():
    analysis_handler = AnalysisStageHandler()
    structured = {
        "patientInfo": {"name": "Patient X"},
        "vitals": [
            {"parameter": "Blood Pressure", "systolic": 190, "diastolic": 125, "unit": "mmHg"},
            {"parameter": "SpO2", "value": 86.0, "unit": "%"},
        ],
        "labResults": [
            {"testName": "Serum Potassium", "value": 2.2, "unit": "mEq/L", "flag": "CRITICAL"},
        ],
        "medications": [],
    }

    analysis = analysis_handler.analyze(structured)

    assert analysis["riskLevel"] == "CRITICAL"
    assert len(analysis["anomalies"]) >= 3
    assert any("Hypertensive Crisis" in a.get("message", "") for a in analysis["anomalies"])
    assert any("hypoxemia" in a.get("message", "") for a in analysis["anomalies"])
    assert any("Critical lab value" in a.get("message", "") for a in analysis["anomalies"])


def test_duplicate_medication_warning():
    analysis_handler = AnalysisStageHandler()
    structured = {
        "medications": [
            {"name": "Tab Ibuprofen 400mg", "dosage": "400mg"},
            {"name": "Tab Naproxen 250mg", "dosage": "250mg"},
        ],
        "labResults": [],
        "vitals": [],
    }

    analysis = analysis_handler.analyze(structured)
    assert any("Duplicate therapeutic class" in w for w in analysis["warnings"])
    assert any("NSAIDs" in w for w in analysis["warnings"])
