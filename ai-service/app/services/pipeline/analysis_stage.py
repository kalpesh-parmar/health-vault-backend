from __future__ import annotations

import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

# Drug classes for duplicate medication detection
KNOWN_DRUG_CLASSES: dict[str, list[str]] = {
    "NSAIDs": ["ibuprofen", "naproxen", "diclofenac", "aceclofenac", "meloxicam", "indomethacin", "etoricoxib"],
    "Statins": ["atorvastatin", "rosuvastatin", "simvastatin", "pravastatin"],
    "ACE_Inhibitors": ["enalapril", "ramipril", "lisinopril", "perindopril"],
    "ARBs": ["telmisartan", "losartan", "olmesartan", "valsartan"],
    "Beta_Blockers": ["metoprolol", "atenolol", "bisoprolol", "carvedilol", "propranolol"],
    "PPIs": ["pantoprazole", "omeprazole", "rabeprazole", "esomeprazole"],
    "Antidiabetics_Metformin": ["metformin", "glycomet"],
    "Antidiabetics_Sulfonylurea": ["glimepiride", "gliclazide", "glipizide"],
}


class AnalysisStageHandler:
    """Stage 7: ANALYZING.
    Performs clinical anomaly detection on lab values and vital signs,
    duplicate drug class warnings, and assigns risk levels.
    """

    def analyze(self, structured_data: dict[str, Any]) -> dict[str, Any]:
        logger.info("Executing clinical anomaly detection and safety analysis...")
        anomalies: list[dict[str, Any]] = []
        warnings: list[str] = []
        clinical_observations: list[str] = []

        # 1. Inspect evaluated lab results for out-of-bounds flags
        lab_results = structured_data.get("labResults") or []
        has_critical = False
        has_high_or_low = False

        for item in lab_results:
            flag = item.get("flag", "NORMAL")
            test_name = item.get("testName") or item.get("canonicalKey") or "Test"
            val = item.get("value")
            unit = item.get("unit") or ""
            ref = item.get("referenceRange") or ""

            if flag == "CRITICAL":
                has_critical = True
                anomaly = {
                    "type": "CRITICAL_LAB_VALUE",
                    "severity": "CRITICAL",
                    "parameter": test_name,
                    "value": val,
                    "unit": unit,
                    "referenceRange": ref,
                    "message": f"Critical lab value detected: {test_name} is {val} {unit} (Reference: {ref}). Requires urgent medical attention.",
                }
                anomalies.append(anomaly)
                warnings.append(anomaly["message"])
            elif flag in ("HIGH", "LOW"):
                has_high_or_low = True
                anomaly = {
                    "type": f"{flag}_LAB_VALUE",
                    "severity": "MODERATE",
                    "parameter": test_name,
                    "value": val,
                    "unit": unit,
                    "referenceRange": ref,
                    "message": f"Abnormal {flag.lower()} value: {test_name} is {val} {unit} (Reference: {ref}).",
                }
                anomalies.append(anomaly)

        # 2. Inspect vital signs
        vitals = structured_data.get("vitals") or []
        for vital in vitals:
            param = vital.get("parameter", "")
            systolic = vital.get("systolic")
            diastolic = vital.get("diastolic")
            val = vital.get("value")

            if systolic is not None:
                if systolic >= 180 or (diastolic and diastolic >= 120):
                    has_critical = True
                    msg = f"Hypertensive Crisis alert: Blood Pressure {systolic}/{diastolic} mmHg is critically elevated."
                    anomalies.append({"type": "CRITICAL_VITALS", "severity": "CRITICAL", "message": msg})
                    warnings.append(msg)
                elif systolic >= 140 or (diastolic and diastolic >= 90):
                    has_high_or_low = True
                    anomalies.append({"type": "HIGH_BP", "severity": "MODERATE", "message": f"Elevated blood pressure: {systolic}/{diastolic} mmHg."})

            if "spo2" in param.lower() and val is not None:
                if val < 90.0:
                    has_critical = True
                    msg = f"Critical hypoxemia: Oxygen saturation (SpO2) is {val}% (Normal >= 95%)."
                    anomalies.append({"type": "CRITICAL_SPO2", "severity": "CRITICAL", "message": msg})
                    warnings.append(msg)
                elif val < 95.0:
                    has_high_or_low = True
                    anomalies.append({"type": "LOW_SPO2", "severity": "MODERATE", "message": f"Borderline oxygen saturation: {val}%."})

        # 3. Duplicate medication / drug-drug duplicate warnings
        medications = structured_data.get("medications") or []
        med_names = [m.get("name", "").lower() for m in medications if m.get("name")]

        for drug_class, drugs in KNOWN_DRUG_CLASSES.items():
            matched = [
                d_name
                for d_name in med_names
                if any(re.search(rf"\b{re.escape(d)}\b", d_name) for d in drugs)
            ]
            if len(matched) >= 2:
                warning_msg = (
                    f"Duplicate therapeutic class detected ({drug_class}): Prescribed medications "
                    f"({', '.join(matched)}) may result in additive adverse effects. Review with prescribing physician."
                )
                warnings.append(warning_msg)
                anomalies.append({"type": "DUPLICATE_MEDICATION_CLASS", "severity": "HIGH", "message": warning_msg})

        # Determine overall document risk level
        if has_critical:
            risk_level = "CRITICAL"
        elif any(a.get("severity") == "HIGH" for a in anomalies):
            risk_level = "HIGH"
        elif has_high_or_low or anomalies:
            risk_level = "MODERATE"
        else:
            risk_level = "NORMAL"

        if anomalies:
            clinical_observations.append(f"Identified {len(anomalies)} clinical parameter(s) requiring attention.")
        else:
            clinical_observations.append("All reported parameters are within expected physiological reference limits.")

        logger.info(
            "Analysis complete: riskLevel=%s, anomalies=%d, warnings=%d",
            risk_level,
            len(anomalies),
            len(warnings),
        )

        return {
            "anomalies": anomalies,
            "warnings": warnings,
            "riskLevel": risk_level,
            "clinicalObservations": clinical_observations,
        }
