from __future__ import annotations

import re
from typing import Any

# Standard clinical reference ranges: (low, high, critical_low, critical_high, default_unit)
CLINICAL_REFERENCE_RANGES: dict[str, tuple[float, float, float | None, float | None, str]] = {
    # Glycemic
    "fasting_blood_glucose": (70.0, 99.0, 54.0, 300.0, "mg/dL"),
    "postprandial_blood_glucose": (70.0, 140.0, 54.0, 350.0, "mg/dL"),
    "random_blood_glucose": (70.0, 140.0, 54.0, 350.0, "mg/dL"),
    "hba1c": (4.0, 5.6, None, 10.0, "%"),

    # Lipid Panel
    "total_cholesterol": (125.0, 200.0, None, 300.0, "mg/dL"),
    "triglycerides": (0.0, 150.0, None, 500.0, "mg/dL"),
    "hdl_cholesterol": (40.0, 60.0, 25.0, None, "mg/dL"),
    "ldl_cholesterol": (0.0, 100.0, None, 190.0, "mg/dL"),

    # Complete Blood Count (CBC)
    "hemoglobin": (12.0, 17.5, 7.0, 20.0, "g/dL"),
    "wbc_count": (4000.0, 11000.0, 2000.0, 30000.0, "cells/mcL"),
    "platelet_count": (150000.0, 450000.0, 50000.0, 1000000.0, "cells/mcL"),
    "rbc_count": (4.0, 5.9, 2.0, 7.0, "M/mcL"),
    "hematocrit": (36.0, 50.0, 20.0, 60.0, "%"),

    # Renal Panel
    "creatinine": (0.6, 1.2, None, 5.0, "mg/dL"),
    "blood_urea_nitrogen": (7.0, 20.0, None, 80.0, "mg/dL"),
    "uric_acid": (3.5, 7.2, None, 12.0, "mg/dL"),

    # Liver Function Test (LFT)
    "bilirubin_total": (0.1, 1.2, None, 12.0, "mg/dL"),
    "sgot_ast": (10.0, 40.0, None, 1000.0, "U/L"),
    "sgpt_alt": (7.0, 56.0, None, 1000.0, "U/L"),
    "alkaline_phosphatase": (44.0, 147.0, None, 500.0, "U/L"),
    "serum_albumin": (3.4, 5.4, 1.5, None, "g/dL"),

    # Electrolytes
    "serum_potassium": (3.5, 5.0, 2.8, 6.2, "mEq/L"),
    "serum_sodium": (135.0, 145.0, 120.0, 160.0, "mEq/L"),
    "serum_calcium": (8.5, 10.2, 6.5, 13.0, "mg/dL"),

    # Thyroid Panel
    "tsh": (0.4, 4.0, 0.05, 20.0, "mIU/L"),
    "free_t3": (2.0, 4.4, None, None, "pg/mL"),
    "free_t4": (0.8, 1.8, None, None, "ng/dL"),

    # Vitals
    "blood_pressure_systolic": (90.0, 120.0, 70.0, 180.0, "mmHg"),
    "blood_pressure_diastolic": (60.0, 80.0, 40.0, 120.0, "mmHg"),
    "heart_rate": (60.0, 100.0, 45.0, 140.0, "bpm"),
    "oxygen_saturation": (95.0, 100.0, 88.0, None, "%"),
    "body_temperature": (97.0, 99.0, 95.0, 104.0, "°F"),
}

# Test name normalization mapping
TEST_NAME_ALIASES: dict[str, str] = {
    "fbs": "fasting_blood_glucose",
    "fasting blood sugar": "fasting_blood_glucose",
    "fasting blood glucose": "fasting_blood_glucose",
    "fasting glucose": "fasting_blood_glucose",
    "ppbs": "postprandial_blood_glucose",
    "post prandial blood sugar": "postprandial_blood_glucose",
    "postprandial blood glucose": "postprandial_blood_glucose",
    "random blood sugar": "random_blood_glucose",
    "rbs": "random_blood_glucose",
    "blood sugar": "random_blood_glucose",
    "glucose": "random_blood_glucose",
    "hba1c": "hba1c",
    "glycated hemoglobin": "hba1c",
    "cholesterol": "total_cholesterol",
    "total cholesterol": "total_cholesterol",
    "serum cholesterol": "total_cholesterol",
    "triglycerides": "triglycerides",
    "tg": "triglycerides",
    "hdl": "hdl_cholesterol",
    "hdl cholesterol": "hdl_cholesterol",
    "ldl": "ldl_cholesterol",
    "ldl cholesterol": "ldl_cholesterol",
    "hb": "hemoglobin",
    "hgb": "hemoglobin",
    "hemoglobin": "hemoglobin",
    "haemoglobin": "hemoglobin",
    "wbc": "wbc_count",
    "total wbc": "wbc_count",
    "total leucocyte count": "wbc_count",
    "tlc": "wbc_count",
    "white blood cells": "wbc_count",
    "platelets": "platelet_count",
    "platelet count": "platelet_count",
    "rbc": "rbc_count",
    "rbc count": "rbc_count",
    "hematocrit": "hematocrit",
    "pcv": "hematocrit",
    "creatinine": "creatinine",
    "serum creatinine": "creatinine",
    "bun": "blood_urea_nitrogen",
    "blood urea nitrogen": "blood_urea_nitrogen",
    "urea": "blood_urea_nitrogen",
    "uric acid": "uric_acid",
    "total bilirubin": "bilirubin_total",
    "bilirubin total": "bilirubin_total",
    "sgot": "sgot_ast",
    "ast": "sgot_ast",
    "sgpt": "sgpt_alt",
    "alt": "sgpt_alt",
    "alkaline phosphatase": "alkaline_phosphatase",
    "alp": "alkaline_phosphatase",
    "albumin": "serum_albumin",
    "potassium": "serum_potassium",
    "serum potassium": "serum_potassium",
    "sodium": "serum_sodium",
    "serum sodium": "serum_sodium",
    "calcium": "serum_calcium",
    "tsh": "tsh",
    "free t3": "free_t3",
    "ft3": "free_t3",
    "free t4": "free_t4",
    "ft4": "free_t4",
    "systolic": "blood_pressure_systolic",
    "systolic bp": "blood_pressure_systolic",
    "diastolic": "blood_pressure_diastolic",
    "diastolic bp": "blood_pressure_diastolic",
    "bp": "blood_pressure_systolic",
    "pulse": "heart_rate",
    "heart rate": "heart_rate",
    "hr": "heart_rate",
    "spo2": "oxygen_saturation",
    "o2 sat": "oxygen_saturation",
    "temp": "body_temperature",
    "temperature": "body_temperature",
}


def normalize_test_key(raw_name: str) -> str:
    cleaned = re.sub(r"[^a-zA-Z0-9\s]", " ", (raw_name or "").lower()).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return TEST_NAME_ALIASES.get(cleaned, cleaned.replace(" ", "_"))


def parse_numeric_value(raw_val: Any) -> float | None:
    if raw_val is None:
        return None
    if isinstance(raw_val, (int, float)) and not isinstance(raw_val, bool):
        return float(raw_val)

    s = str(raw_val).strip()
    match = re.search(r"[-+]?\d*\.?\d+", s)
    if match:
        try:
            return float(match.group(0))
        except ValueError:
            return None
    return None


class LabEvaluator:
    """Evaluates medical laboratory results and vital signs against clinical reference ranges."""

    @staticmethod
    def evaluate_result(
        test_name: str,
        value: Any,
        unit: str | None = None,
        custom_low: float | None = None,
        custom_high: float | None = None,
    ) -> dict[str, Any]:
        canonical_key = normalize_test_key(test_name)
        num_val = parse_numeric_value(value)

        # Standard bounds
        standard_spec = CLINICAL_REFERENCE_RANGES.get(canonical_key)
        if standard_spec:
            low, high, crit_low, crit_high, default_unit = standard_spec
            ref_unit = unit or default_unit
        else:
            low = custom_low if custom_low is not None else 0.0
            high = custom_high if custom_high is not None else 0.0
            crit_low = None
            crit_high = None
            ref_unit = unit or ""

        # Overrides if custom range provided
        if custom_low is not None:
            low = custom_low
        if custom_high is not None:
            high = custom_high

        flag = "NORMAL"
        is_critical = False
        is_abnormal = False

        if num_val is not None and (low > 0.0 or high > 0.0 or standard_spec):
            # Check Critical first
            if crit_low is not None and num_val <= crit_low:
                flag = "CRITICAL"
                is_critical = True
                is_abnormal = True
            elif crit_high is not None and num_val >= crit_high:
                flag = "CRITICAL"
                is_critical = True
                is_abnormal = True
            elif low > 0.0 and num_val < low:
                flag = "LOW"
                is_abnormal = True
            elif high > 0.0 and num_val > high:
                flag = "HIGH"
                is_abnormal = True

        ref_str = f"{low} - {high} {ref_unit}".strip() if (low > 0.0 or high > 0.0) else "See lab reference"

        return {
            "testName": test_name.strip() if test_name else "Unknown Test",
            "canonicalKey": canonical_key,
            "value": num_val if num_val is not None else value,
            "rawValue": str(value) if value is not None else "",
            "unit": ref_unit,
            "referenceRange": ref_str,
            "flag": flag,
            "isAbnormal": is_abnormal,
            "isCritical": is_critical,
        }

    @classmethod
    def evaluate_all(cls, lab_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        results = []
        for item in lab_items:
            test_name = item.get("testName") or item.get("name") or item.get("parameter") or ""
            val = item.get("value")
            unit = item.get("unit")
            eval_res = cls.evaluate_result(test_name, val, unit=unit)
            # preserve extra fields from item
            merged = {**item, **eval_res}
            results.append(merged)
        return results
