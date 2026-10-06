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

    # CBC & Differential
    "hemoglobin": (12.0, 17.5, 7.0, 20.0, "g/dL"),
    "wbc_count": (4000.0, 11000.0, 2000.0, 30000.0, "cells/mcL"),
    "platelet_count": (150000.0, 450000.0, 50000.0, 1000000.0, "cells/mcL"),
    "rbc_count": (4.0, 5.9, 2.0, 7.0, "M/mcL"),
    "hematocrit": (36.0, 50.0, 20.0, 60.0, "%"),
    "mcv": (80.0, 100.0, None, None, "fL"),
    "mch": (27.0, 33.0, None, None, "pg"),
    "mchc": (32.0, 36.0, None, None, "g/dL"),
    "rdw_cv": (11.5, 14.5, None, None, "%"),
    "lymphocyte": (20.0, 40.0, None, None, "%"),
    "neutrophil": (40.0, 75.0, None, None, "%"),
    "eosinophil": (1.0, 6.0, None, None, "%"),
    "monocyte": (2.0, 10.0, None, None, "%"),
    "basophil": (0.0, 2.0, None, None, "%"),

    # Coagulation
    "prothrombin_time": (11.0, 15.0, None, None, "sec"),
    "aptt": (25.0, 38.0, None, None, "sec"),
    # TODO: clinician sign-off required
    "inr": (0.8, 1.2, None, None, ""),

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
    "total_t3": (0.8, 2.0, None, None, "ng/mL"),
    "total_t4": (5.0, 12.0, None, None, "ug/dL"),
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
    # Glycemic
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
    "glucose pp": "postprandial_blood_glucose",
    "hba1c": "hba1c",
    "glycated hemoglobin": "hba1c",
    "glycosylated hemoglobin": "hba1c",

    # Lipid Panel
    "cholesterol": "total_cholesterol",
    "total cholesterol": "total_cholesterol",
    "serum cholesterol": "total_cholesterol",
    "triglycerides": "triglycerides",
    "tg": "triglycerides",
    "hdl": "hdl_cholesterol",
    "hdl cholesterol": "hdl_cholesterol",
    "ldl": "ldl_cholesterol",
    "ldl cholesterol": "ldl_cholesterol",

    # CBC & Differential
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
    "red blood cells": "rbc_count",
    "hematocrit": "hematocrit",
    "pcv": "hematocrit",
    "packed cell volume": "hematocrit",
    "mcv": "mcv",
    "mean corpuscular volume": "mcv",
    "mch": "mch",
    "mean corpuscular hemoglobin": "mch",
    "mchc": "mchc",
    "mean corpuscular hemoglobin concentration": "mchc",
    "rdw": "rdw_cv",
    "rdw cv": "rdw_cv",
    "red cell distribution width": "rdw_cv",
    "lymphocyte": "lymphocyte",
    "lymphocytes": "lymphocyte",
    "neutrophil": "neutrophil",
    "neutrophils": "neutrophil",
    "monocyte": "monocyte",
    "monocytes": "monocyte",
    "eosinophil": "eosinophil",
    "eosinophils": "eosinophil",
    "basophil": "basophil",
    "basophils": "basophil",

    # Coagulation
    "pt": "prothrombin_time",
    "prothrombin time": "prothrombin_time",
    "prothrombin time pt": "prothrombin_time",
    "aptt": "aptt",
    "activated partial thromboplastin time": "aptt",
    "ptt": "aptt",
    "inr": "inr",
    "international normalized ratio": "inr",

    # Renal Panel
    "creatinine": "creatinine",
    "serum creatinine": "creatinine",
    "bun": "blood_urea_nitrogen",
    "blood urea nitrogen": "blood_urea_nitrogen",
    "urea": "blood_urea_nitrogen",
    "uric acid": "uric_acid",

    # LFT
    "total bilirubin": "bilirubin_total",
    "bilirubin total": "bilirubin_total",
    "bilirubin": "bilirubin_total",
    "sgot": "sgot_ast",
    "ast": "sgot_ast",
    "sgpt": "sgpt_alt",
    "alt": "sgpt_alt",
    "alkaline phosphatase": "alkaline_phosphatase",
    "alp": "alkaline_phosphatase",
    "albumin": "serum_albumin",

    # Electrolytes
    "potassium": "serum_potassium",
    "serum potassium": "serum_potassium",
    "sodium": "serum_sodium",
    "serum sodium": "serum_sodium",
    "calcium": "serum_calcium",

    # Thyroid Panel
    "tsh": "tsh",
    "t3": "total_t3",
    "triiodothyronine": "total_t3",
    "total t3": "total_t3",
    "t4": "total_t4",
    "thyroxine": "total_t4",
    "total t4": "total_t4",
    "free t3": "free_t3",
    "ft3": "free_t3",
    "free t4": "free_t4",
    "ft4": "free_t4",

    # Vitals
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


class LabRangeParser:
    """Parses printed clinical laboratory reference ranges, tiered texts, and time durations."""

    @staticmethod
    def parse_time_value_to_seconds(raw_val: Any) -> float | None:
        if raw_val is None or not isinstance(raw_val, str):
            return None
        s = raw_val.strip()
        if not re.search(r"\b(?:min|sec|m|s)\b", s, re.I):
            return None

        m_min = re.search(r"(\d+(?:\.\d+)?)\s*(?:min|m)\b", s, re.I)
        m_sec = re.search(r"(\d+(?:\.\d+)?)\s*(?:sec|s)\b", s, re.I)
        if not m_min and not m_sec:
            return None
        mins = float(m_min.group(1)) if m_min else 0.0
        secs = float(m_sec.group(1)) if m_sec else 0.0
        return mins * 60.0 + secs

    @staticmethod
    def parse_range(range_str: str | None) -> dict[str, Any]:
        default_res = {
            "low": None,
            "high": None,
            "operator": None,
            "tiers": [],
            "raw_text": range_str if range_str is not None else "",
            "status": "no_range",
            "is_time": False,
        }
        if not range_str or not isinstance(range_str, str):
            return default_res

        raw = range_str.strip()
        if not raw:
            return default_res

        # 1. Tiered ranges (e.g. "< 5.7 : Normal / 5.7 - 6.4 : Prediabetic / >= 6.5 : Diabetic")
        if "/" in raw and ":" in raw:
            chunks = [c.strip() for c in raw.split("/") if c.strip()]
            tiers = []
            for chunk in chunks:
                if ":" in chunk:
                    expr, label = chunk.split(":", 1)
                    tier_label = label.strip().lower()
                    expr = expr.strip()
                    m_op = re.match(r"^(<=?|>=?)\s*([\d,]+(?:\.\d+)?)", expr)
                    m_hyphen = re.match(r"^([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*([\d,]+(?:\.\d+)?)", expr, re.I)
                    if m_op:
                        op = m_op.group(1)
                        val = float(m_op.group(2).replace(",", ""))
                        if "<" in op:
                            tiers.append({"tier": tier_label, "low": None, "high": val, "operator": op})
                        else:
                            tiers.append({"tier": tier_label, "low": val, "high": None, "operator": op})
                    elif m_hyphen:
                        l_val = float(m_hyphen.group(1).replace(",", ""))
                        h_val = float(m_hyphen.group(2).replace(",", ""))
                        tiers.append({"tier": tier_label, "low": l_val, "high": h_val, "operator": "-"})
            if tiers:
                return {
                    "low": None,
                    "high": None,
                    "operator": "tiered",
                    "tiers": tiers,
                    "raw_text": raw,
                    "status": "parsed",
                    "is_time": False,
                }

        # 2. Time-duration ranges (e.g. "Up To 7 min.", "Up to 9 min.")
        m_up_to = re.search(r"up\s*to\s*(\d+(?:\.\d+)?)\s*(min|m|sec|s)(?:\.|\b)", raw, re.I)
        if m_up_to:
            val = float(m_up_to.group(1))
            unit_part = m_up_to.group(2).lower()
            if "min" in unit_part or unit_part == "m":
                high_secs = val * 60.0
                m_extra_sec = re.search(r"(\d+(?:\.\d+)?)\s*(?:sec|s)(?:\.|\b)", raw[m_up_to.end():], re.I)
                if m_extra_sec:
                    high_secs += float(m_extra_sec.group(1))
            else:
                high_secs = val
            return {
                "low": None,
                "high": high_secs,
                "operator": "<=",
                "tiers": [],
                "raw_text": raw,
                "status": "parsed",
                "is_time": True,
            }

        # 3. Single operator with optional explanatory colon (e.g. "> 200 : Provisional Diagnosis of Diabetes")
        expr_part = raw
        if ":" in raw:
            expr_part = raw.split(":", 1)[0].strip()

        m_single = re.match(r"^(<=?|>=?)\s*([\d,]+(?:\.\d+)?)", expr_part)
        if m_single:
            op = m_single.group(1)
            val = float(m_single.group(2).replace(",", ""))
            if "<" in op:
                return {
                    "low": None,
                    "high": val,
                    "operator": op,
                    "tiers": [],
                    "raw_text": raw,
                    "status": "parsed",
                    "is_time": False,
                }
            else:
                return {
                    "low": val,
                    "high": None,
                    "operator": op,
                    "tiers": [],
                    "raw_text": raw,
                    "status": "parsed",
                    "is_time": False,
                }

        # 4. Standard hyphen/to range (e.g. "12 - 15", "3.8-4.8", "150000-410000", "13.87-18.27", "150,000 - 450,000", "13.87 - 18.27 Sec")
        m_range = re.search(r"^\s*([\d,]+(?:\.\d+)?)\s*(?:-|to)\s*([\d,]+(?:\.\d+)?)", raw, re.I)
        if m_range:
            low_val = float(m_range.group(1).replace(",", ""))
            high_val = float(m_range.group(2).replace(",", ""))
            is_time = bool(re.search(r"\b(?:sec|s|min|m)\b", raw, re.I))
            return {
                "low": low_val,
                "high": high_val,
                "operator": "-",
                "tiers": [],
                "raw_text": raw,
                "status": "parsed",
                "is_time": is_time,
            }

        # 5. Bare number or unparseable text
        return {
            "low": None,
            "high": None,
            "operator": None,
            "tiers": [],
            "raw_text": raw,
            "status": "no_range",
            "is_time": False,
        }


class LabEvaluator:
    """Evaluates medical laboratory results and vital signs against clinical reference ranges."""

    @staticmethod
    def evaluate_result(
        test_name: str,
        value: Any,
        unit: str | None = None,
        custom_low: float | None = None,
        custom_high: float | None = None,
        reference_range: str | None = None,
        lab_flag: str | None = None,
    ) -> dict[str, Any]:
        canonical_key = normalize_test_key(test_name)
        raw_val_str = str(value) if value is not None else ""

        # 1. Informational tests (calculated/mean/ratio values)
        info_keywords = (
            "mean plasma glucose",
            "mean blood glucose",
            "isi",
            "international sensitivity index",
        )
        norm_name = (test_name or "").lower()
        is_informational = (
            any(k in norm_name for k in info_keywords)
            or ("pt" in norm_name and any(w in norm_name for w in ("mean", "control")))
            or ("aptt" in norm_name and any(w in norm_name for w in ("mean", "control", "ratio")))
            or (
                canonical_key in (
                    "mean_plasma_glucose",
                    "pt_mean",
                    "aptt_mean",
                    "aptt_control",
                    "pt_control",
                    "aptt_ratio",
                    "isi",
                )
            )
        )

        # 2. Parse numeric value (including time-duration string e.g. "02 Min 15 Sec")
        time_seconds = LabRangeParser.parse_time_value_to_seconds(value) if isinstance(value, str) else None
        if time_seconds is not None:
            num_val = time_seconds
        else:
            num_val = parse_numeric_value(value)

        # 3. Unit Warning for HbA1c in mg/dL
        unit_warning = False
        unit_warning_message = None
        if canonical_key == "hba1c" and unit and "mg" in unit.lower():
            unit_warning = True
            unit_warning_message = "HbA1c is normally reported in %"

        # 4. Reference range and status resolution
        range_source = None
        range_low = None
        range_high = None
        ref_str = reference_range or ""
        reference_raw = reference_range or ""
        parsed = None

        if reference_range:
            parsed = LabRangeParser.parse_range(reference_range)

        if is_informational:
            computed_status = "info"
            range_source = None
            if not ref_str:
                ref_str = f"{unit}".strip() if unit else ""
        elif parsed and parsed["status"] == "parsed":
            range_source = "printed"
            op = parsed["operator"]
            if op == "tiered":
                matched_tier = None
                if num_val is not None:
                    for tier in parsed["tiers"]:
                        t_op = tier.get("operator")
                        t_low = tier.get("low")
                        t_high = tier.get("high")
                        if t_op == "<" and t_high is not None and num_val < t_high:
                            matched_tier = tier["tier"]
                            break
                        elif t_op == "<=" and t_high is not None and num_val <= t_high:
                            matched_tier = tier["tier"]
                            break
                        elif t_op == ">" and t_low is not None and num_val > t_low:
                            matched_tier = tier["tier"]
                            break
                        elif t_op == ">=" and t_low is not None and num_val >= t_low:
                            matched_tier = tier["tier"]
                            break
                        elif t_op == "-" and t_low is not None and t_high is not None and t_low <= num_val <= t_high:
                            matched_tier = tier["tier"]
                            break
                computed_status = matched_tier or "normal"
            elif op in ("<", "<="):
                range_high = parsed["high"]
                if num_val is not None and range_high is not None:
                    is_normal = (num_val < range_high) if op == "<" else (num_val <= range_high)
                    computed_status = "normal" if is_normal else "high"
                else:
                    computed_status = "no_range"
            elif op in (">", ">="):
                range_low = parsed["low"]
                if num_val is not None and range_low is not None:
                    raw_lower = (reference_range or "").lower()
                    is_pathological_threshold = any(
                        w in raw_lower for w in ("provisional", "diabet", "positive", "reactive", "abnormal")
                    ) or (
                        canonical_key in ("random_blood_glucose", "fasting_blood_glucose", "postprandial_blood_glucose")
                    )
                    if is_pathological_threshold:
                        computed_status = "high" if num_val > range_low else "normal"
                        range_high = range_low
                        range_low = None
                    else:
                        computed_status = "normal" if (num_val > range_low if op == ">" else num_val >= range_low) else "low"
                else:
                    computed_status = "no_range"
            elif op == "-":
                range_low = parsed["low"]
                range_high = parsed["high"]
                if num_val is not None and range_low is not None and range_high is not None:
                    if num_val < range_low:
                        computed_status = "low"
                    elif num_val > range_high:
                        computed_status = "high"
                    else:
                        computed_status = "normal"
                else:
                    computed_status = "no_range"
            else:
                computed_status = "no_range"
                range_source = None
        elif custom_low is not None or custom_high is not None:
            range_low = custom_low
            range_high = custom_high
            if num_val is not None:
                if range_low is not None and num_val < range_low:
                    computed_status = "low"
                elif range_high is not None and num_val > range_high:
                    computed_status = "high"
                else:
                    computed_status = "normal"
            else:
                computed_status = "no_range"
            ref_str = f"{range_low} - {range_high} {unit or ''}".strip()
        elif canonical_key in CLINICAL_REFERENCE_RANGES:
            # Check generic INR config flag (TODO: clinician sign-off required)
            allow_generic = False
            if canonical_key == "inr":
                try:
                    from app.settings import settings
                    allow_generic = getattr(settings, "enable_generic_inr_range", False)
                except Exception:
                    allow_generic = False
            elif canonical_key in CLINICAL_REFERENCE_RANGES:
                allow_generic = True

            if allow_generic:
                g_low, g_high, _, _, g_unit = CLINICAL_REFERENCE_RANGES[canonical_key]
                range_source = "generic"
                range_low = g_low
                range_high = g_high
                if canonical_key == "hba1c" and num_val is not None:
                    if num_val < 5.7:
                        computed_status = "normal"
                    elif 5.7 <= num_val < 6.5:
                        computed_status = "prediabetic"
                    else:
                        computed_status = "diabetic"
                elif num_val is not None:
                    if num_val < g_low:
                        computed_status = "low"
                    elif num_val > g_high:
                        computed_status = "high"
                    else:
                        computed_status = "normal"
                else:
                    computed_status = "no_range"
                unit_str = f" {g_unit}".strip()
                ref_str = f"{g_low} - {g_high}" + (f" {unit_str}" if unit_str else "")
            else:
                computed_status = "no_range"
                range_source = None
                ref_str = None
        else:
            computed_status = "no_range"
            range_source = None
            ref_str = None

        # Sanitize "See lab reference" to null reference so UI shows localized "Range not provided"
        if ref_str and "see lab reference" in str(ref_str).lower():
            ref_str = None
        if reference_raw and "see lab reference" in str(reference_raw).lower() and range_source != "generic":
            ref_str = None
        if computed_status == "no_range" and range_source is None:
            ref_str = None

        # HbA1c tiered override for clinical cutoffs
        if not is_informational and canonical_key == "hba1c" and num_val is not None:
            if num_val >= 6.5:
                computed_status = "diabetic"
            elif num_val >= 5.7:
                computed_status = "prediabetic"
            else:
                computed_status = "normal"

        # 5. Severity computation
        severity = None
        if not is_informational and computed_status in ("low", "high") and num_val is not None:
            if computed_status == "high" and range_high is not None and range_high > 0:
                diff = num_val - range_high
                pct = diff / range_high
                if pct <= 0.05:
                    severity = "borderline"
                elif pct <= 0.20:
                    severity = "mild"
                else:
                    severity = "significant"
            elif computed_status == "low" and range_low is not None and range_low > 0:
                diff = range_low - num_val
                pct = diff / range_low
                if pct <= 0.05:
                    severity = "borderline"
                elif pct <= 0.20:
                    severity = "mild"
                else:
                    severity = "significant"

        # 6. Printed lab flag and conflict check
        flag_conflict = False
        clean_lab_flag = None
        if lab_flag:
            lf = str(lab_flag).strip().upper()
            if lf in ("L", "LOW"):
                clean_lab_flag = "L"
            elif lf in ("H", "HIGH"):
                clean_lab_flag = "H"

        if clean_lab_flag is not None:
            if clean_lab_flag == "L" and computed_status != "low":
                flag_conflict = True
            elif clean_lab_flag == "H" and computed_status != "high":
                flag_conflict = True

        # 7. Status, Flag, isAbnormal, isCritical
        status = computed_status
        if status == "diabetic":
            flag = "diabetic"
            is_abnormal = True
        elif status == "prediabetic":
            flag = "prediabetic"
            is_abnormal = True
        elif status == "info":
            flag = "info"
            is_abnormal = False
        elif status == "low":
            flag = "LOW"
            is_abnormal = True
        elif status == "high":
            flag = "HIGH"
            is_abnormal = True
        elif status == "normal":
            flag = "NORMAL"
            is_abnormal = False
        else:
            flag = "NO_RANGE"
            is_abnormal = False

        is_critical = False
        if canonical_key in CLINICAL_REFERENCE_RANGES and num_val is not None:
            _, _, crit_low, crit_high, _ = CLINICAL_REFERENCE_RANGES[canonical_key]
            if crit_low is not None and num_val <= crit_low:
                is_critical = True
                flag = "CRITICAL"
                is_abnormal = True
            elif crit_high is not None and num_val >= crit_high:
                is_critical = True
                flag = "CRITICAL"
                is_abnormal = True

        # Tiers extraction (keep all tiers in payload for UI rendering)
        tiers = list(parsed.get("tiers") or []) if ("parsed" in locals() and parsed) else []
        if canonical_key == "hba1c" and not tiers:
            tiers = [
                {"tier": "normal", "low": None, "high": 5.7, "operator": "<", "label": "Normal"},
                {"tier": "prediabetic", "low": 5.7, "high": 6.4, "operator": "-", "label": "Prediabetic"},
                {"tier": "diabetic", "low": 6.5, "high": None, "operator": ">=", "label": "Diabetic"},
            ]

        return {
            "testName": test_name.strip() if test_name else "Unknown Test",
            "canonicalKey": canonical_key,
            "value": num_val if num_val is not None else value,
            "rawValue": raw_val_str,
            "unit": unit or "",
            "referenceRange": ref_str,
            "reference_raw": reference_raw,
            "flag": flag,
            "status": status,
            "computed_status": computed_status,
            "lab_flag": clean_lab_flag,
            "flag_conflict": flag_conflict,
            "severity": severity,
            "range_source": range_source,
            "is_informational": is_informational,
            "unit_warning": unit_warning,
            "unit_warning_message": unit_warning_message,
            "isAbnormal": is_abnormal,
            "isCritical": is_critical,
            "tiers": tiers,
        }

    @classmethod
    def evaluate_all(cls, lab_items: list[dict[str, Any]]) -> list[dict[str, Any]]:
        results = []
        for item in lab_items:
            test_name = item.get("testName") or item.get("name") or item.get("parameter") or ""
            method = item.get("method")
            if not method:
                m_method = re.search(
                    r"\((photometric|measured|clia|hplc|calculation|photo optical)\)",
                    test_name,
                    re.I,
                )
                if m_method:
                    m_str = m_method.group(1)
                    method = m_str.upper() if m_str.lower() in ("clia", "hplc") else m_str.title()
                    test_name = re.sub(
                        r"\s*\((photometric|measured|clia|hplc|calculation|photo optical)\)",
                        "",
                        test_name,
                        flags=re.I,
                    ).strip()
                elif re.search(r"\b(HPLC|CLIA|Photometric|Photo Optical)\b", test_name, re.I):
                    m2 = re.search(r"\b(HPLC|CLIA|Photometric|Photo Optical)\b", test_name, re.I)
                    if m2:
                        m_str = m2.group(1)
                        method = m_str.upper() if m_str.lower() in ("clia", "hplc") else m_str.title()
                        test_name = re.sub(
                            r"\b(HPLC|CLIA|Photometric|Photo Optical)\b", "", test_name, flags=re.I
                        ).strip()

            val = item.get("value")
            unit = item.get("unit")
            ref_range = (
                item.get("referenceRange")
                or item.get("reference_range")
                or item.get("reference")
                or item.get("reference_raw")
            )
            lab_flag = item.get("flag") or item.get("lab_flag")
            eval_res = cls.evaluate_result(
                test_name,
                val,
                unit=unit,
                reference_range=ref_range,
                lab_flag=lab_flag,
            )
            merged = {**item, **eval_res, "testName": test_name}
            if method:
                merged["method"] = method
            results.append(merged)
        return results

    @classmethod
    def group_by_sections(cls, evaluated_labs: list[dict[str, Any]]) -> list[dict[str, Any]]:
        """Groups flat evaluated lab parameters into standard report sections and merges differential pairs."""
        cbc_items: list[dict[str, Any]] = []
        diff_raw: list[dict[str, Any]] = []
        bleeding_clotting_items: list[dict[str, Any]] = []
        biochemistry_items: list[dict[str, Any]] = []
        hba1c_items: list[dict[str, Any]] = []
        coagulation_items: list[dict[str, Any]] = []
        thyroid_items: list[dict[str, Any]] = []
        other_items: list[dict[str, Any]] = []

        for item in evaluated_labs:
            name = (item.get("testName") or item.get("name") or "").strip()
            name_lower = name.lower()
            key = (item.get("canonicalKey") or "").lower()

            # Differential analytes
            if any(
                d in name_lower
                for d in ("polymorph", "neutrophil", "lymphocyte", "eosinophil", "monocyte", "basophil")
            ):
                diff_raw.append(item)
            # Bleeding / Clotting Time
            elif any(k in name_lower for k in ("bleeding time", "clotting time")):
                bleeding_clotting_items.append(item)
            # HbA1c and Mean Plasma Glucose
            elif any(k in name_lower or k in key for k in ("hba1c", "glycated hemoglobin", "mean plasma glucose")):
                hba1c_items.append(item)
            # Coagulation
            elif any(k in name_lower or k in key for k in ("pt", "prothrombin", "aptt", "inr", "isi")):
                coagulation_items.append(item)
            # Thyroid
            elif any(k in name_lower or k in key for k in ("t3", "t4", "tsh", "thyroid")):
                thyroid_items.append(item)
            # CBC
            elif any(
                k in name_lower or k in key
                for k in (
                    "hemoglobin", "haemoglobin", "rbc", "wbc", "platelet", "hematocrit", "pcv",
                    "mcv", "mch", "mchc", "rdw"
                )
            ):
                cbc_items.append(item)
            # Biochemistry
            elif any(
                k in name_lower or k in key
                for k in (
                    "glucose", "sugar", "creatinine", "urea", "bun", "uric", "bilirubin", "sgot", "sgpt",
                    "ast", "alt", "alkaline", "alp", "albumin", "electrolyte", "sodium", "potassium", "calcium"
                )
            ):
                biochemistry_items.append(item)
            else:
                other_items.append(item)

        # Merge differential pairs
        diff_merged_map: dict[str, dict[str, Any]] = {}
        diff_order = ["Polymorphs", "Lymphocyte", "Eosinophils", "Monocytes", "Basophils"]
        for base in diff_order:
            diff_merged_map[base] = {
                "name": base,
                "percent": None,
                "absolute": None,
                "status": "normal",
                "severity": None,
            }

        for item in diff_raw:
            t_name = item.get("testName") or item.get("name") or ""
            t_lower = t_name.lower()
            matched_base = None
            for base in diff_order:
                if base.lower()[:5] in t_lower:
                    matched_base = base
                    break
            if not matched_base:
                matched_base = t_name

            if matched_base not in diff_merged_map:
                diff_merged_map[matched_base] = {
                    "name": matched_base,
                    "percent": None,
                    "absolute": None,
                    "status": "normal",
                    "severity": None,
                }

            is_abs = "absolute" in t_lower or "/c" in (item.get("unit") or "") or "cumm" in (item.get("unit") or "")
            if is_abs:
                diff_merged_map[matched_base]["absolute"] = item
            else:
                diff_merged_map[matched_base]["percent"] = item

        diff_items: list[dict[str, Any]] = []
        for base in diff_order:
            if base in diff_merged_map:
                entry = diff_merged_map[base]
                p_item = entry.get("percent") or {}
                a_item = entry.get("absolute") or {}
                statuses = [p_item.get("status"), a_item.get("status")]
                severities = [p_item.get("severity"), a_item.get("severity")]

                if "borderline" in severities and not any(s in ("mild", "significant") for s in severities):
                    entry["severity"] = "borderline"
                    entry["status"] = "high" if "high" in statuses else ("low" if "low" in statuses else "normal")
                elif any(s in ("mild", "significant") for s in severities):
                    entry["severity"] = "significant" if "significant" in severities else "mild"
                    entry["status"] = "high" if "high" in statuses else ("low" if "low" in statuses else "abnormal")
                elif "normal" in statuses:
                    entry["status"] = "normal"
                    entry["severity"] = None
                elif "no_range" in statuses:
                    entry["status"] = "no_range"
                    entry["severity"] = None
                diff_items.append(entry)

        def compute_counts(items: list[dict[str, Any]]) -> dict[str, int]:
            c = {"abnormal": 0, "borderline": 0, "normal": 0, "no_range": 0, "info": 0}
            for it in items:
                st = it.get("status")
                sev = it.get("severity")
                if st == "info" or it.get("is_informational"):
                    c["info"] += 1
                elif st == "no_range":
                    c["no_range"] += 1
                elif sev == "borderline":
                    c["borderline"] += 1
                elif st in ("low", "high", "diabetic", "prediabetic", "abnormal"):
                    c["abnormal"] += 1
                elif st == "normal":
                    c["normal"] += 1
                else:
                    c["normal"] += 1
            return c

        sections = [
            {
                "sectionName": "Complete Blood Count",
                "items": cbc_items,
                "counts": compute_counts(cbc_items),
            },
            {
                "sectionName": "Differential",
                "items": diff_items,
                "counts": compute_counts(diff_items),
            },
            {
                "sectionName": "Bleeding/Clotting Time",
                "items": bleeding_clotting_items,
                "counts": compute_counts(bleeding_clotting_items),
            },
            {
                "sectionName": "Biochemistry",
                "items": biochemistry_items,
                "counts": compute_counts(biochemistry_items),
            },
            {
                "sectionName": "HbA1c",
                "items": hba1c_items,
                "counts": compute_counts(hba1c_items),
            },
            {
                "sectionName": "Coagulation",
                "items": coagulation_items,
                "counts": compute_counts(coagulation_items),
            },
            {
                "sectionName": "Thyroid",
                "items": thyroid_items,
                "counts": compute_counts(thyroid_items),
            },
        ]
        if other_items:
            sections.append({
                "sectionName": "Other",
                "items": other_items,
                "counts": compute_counts(other_items),
            })
        return sections

