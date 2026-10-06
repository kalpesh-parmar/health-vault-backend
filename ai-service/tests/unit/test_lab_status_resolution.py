from __future__ import annotations

import pytest
from app.services.pipeline.lab_evaluator import LabEvaluator, LabRangeParser


# 46 Table-driven test cases covering edge values, operators, tiered ranges,
# severity thresholds, flag conflicts, informational params, and generic fallbacks.
TEST_CASES = [
    # 1-6: Hyphen range boundary inclusiveness & severity
    ("Hemoglobin", 12.0, "12.0 - 15.0", None, "g/dL", "normal", None, False, False),
    ("Hemoglobin", 15.0, "12.0 - 15.0", None, "g/dL", "normal", None, False, False),
    ("Hemoglobin", 11.9, "12.0 - 15.0", None, "g/dL", "low", "borderline", False, False),  # 0.83% below
    ("Hemoglobin", 15.5, "12.0 - 15.0", None, "g/dL", "high", "borderline", False, False),  # 3.33% above
    ("Hemoglobin", 10.0, "12.0 - 15.0", None, "g/dL", "low", "mild", False, False),  # 16.67% below
    ("Hemoglobin", 8.0, "12.0 - 15.0", None, "g/dL", "low", "significant", False, False),  # 33.33% below
    ("Hemoglobin", 17.0, "12.0 - 15.0", None, "g/dL", "high", "mild", False, False),  # 13.33% above
    ("Hemoglobin", 20.0, "12.0 - 15.0", None, "g/dL", "high", "significant", False, False),  # 33.33% above

    # 7-11: Thousands separators & large integers
    ("Platelets", 150000, "150,000 - 450,000", None, "cumm", "normal", None, False, False),
    ("Platelets", 450000, "150,000 - 450,000", None, "cumm", "normal", None, False, False),
    ("Platelets", 145000, "150,000 - 450,000", None, "cumm", "low", "borderline", False, False),  # 3.33% below
    ("Platelets", 460000, "150,000 - 450,000", None, "cumm", "high", "borderline", False, False),  # 2.22% above
    ("Platelets", 550000, "150,000 - 450,000", None, "cumm", "high", "significant", False, False),  # 22.2% above

    # 12-16: Small decimal numbers and operator '< 0.5'
    ("Bilirubin", 0.3, "< 0.5", None, "mg/dL", "normal", None, False, False),
    ("Bilirubin", 0.5, "< 0.5", None, "mg/dL", "high", "borderline", False, False),  # at limit of strict <
    ("Bilirubin", 0.7, "< 0.5", None, "mg/dL", "high", "significant", False, False),  # 40% above
    ("Glucose PP", 140.0, "<= 140.0", None, "mg/dL", "normal", None, False, False),
    ("Glucose PP", 143.0, "<= 140.0", None, "mg/dL", "high", "borderline", False, False),  # 2.14% above

    # 17-21: Tiered HbA1c tests
    ("HbA1c", 5.2, "< 5.7 : Normal / 5.7 - 6.4 : Prediabetic / >= 6.5 : Diabetic", None, "%", "normal", None, False, False),
    ("HbA1c", 5.7, "< 5.7 : Normal / 5.7 - 6.4 : Prediabetic / >= 6.5 : Diabetic", None, "%", "prediabetic", None, False, False),
    ("HbA1c", 6.4, "< 5.7 : Normal / 5.7 - 6.4 : Prediabetic / >= 6.5 : Diabetic", None, "%", "prediabetic", None, False, False),
    ("HbA1c", 6.5, "< 5.7 : Normal / 5.7 - 6.4 : Prediabetic / >= 6.5 : Diabetic", None, "%", "diabetic", None, False, False),
    ("HbA1c", 9.0, "< 5.7 : Normal / 5.7 - 6.4 : Prediabetic / >= 6.5 : Diabetic", None, "%", "diabetic", None, False, False),

    # 22-23: HbA1c unit warning
    ("HbA1c", 9.0, "< 5.7 : Normal / 5.7 - 6.4 : Prediabetic / >= 6.5 : Diabetic", None, "mg/dL", "diabetic", None, False, True),
    ("HbA1c", 5.4, None, None, "%", "normal", None, False, False),

    # 24-27: Informational parameters
    ("Mean Plasma Glucose", 212.20, None, None, "mg/dL", "info", None, False, False),
    ("PT Mean", 14.5, "13.0 - 15.0", None, "sec", "info", None, False, False),
    ("APTT Control", 30.0, "28.0 - 32.0", None, "sec", "info", None, False, False),
    ("ISI", 1.05, None, None, "", "info", None, False, False),

    # 28-33: Printed lab flag and conflict detection
    ("Hemoglobin", 11.20, "12.0 - 15.0", "L", "gm%", "low", "mild", False, False),
    ("Hemoglobin", 16.50, "12.0 - 15.0", "H", "gm%", "high", "mild", False, False),
    ("Hemoglobin", 11.20, "12.0 - 15.0", "H", "gm%", "low", "mild", True, False),  # flag conflict! L computed vs H printed
    ("Hemoglobin", 16.50, "12.0 - 15.0", "L", "gm%", "high", "mild", True, False),  # flag conflict!
    ("Hemoglobin", 13.50, "12.0 - 15.0", "L", "gm%", "normal", None, True, False),  # flag conflict! normal vs L
    ("Prothrombin Time", 18.5, "13.87-18.27", None, "Sec", "high", "borderline", False, False),  # no conflict when flag none

    # 34-36: Generic reference fallback when printed range is absent
    ("Creatinine", 1.0, None, None, "mg/dL", "normal", None, False, False),
    ("Creatinine", 2.0, None, None, "mg/dL", "high", "significant", False, False),  # > 1.2
    ("Creatinine", 0.4, None, None, "mg/dL", "low", "significant", False, False),  # < 0.6

    # 37-38: No range available
    ("Novel Biomarker XYZ", 42.0, None, None, "U/mL", "no_range", None, False, False),
    ("Basophil Absolute", 0.0, "100.0", None, "/cumm", "no_range", None, False, False),  # bare number has no range

    # 39-40: Time duration parsing and evaluation
    ("Bleeding Time", "02 Min 15 Sec", "Up To 7 min.", None, "", "normal", None, False, False),
    ("Clotting Time", "08 Min 30 Sec", "Up To 7 min.", None, "", "high", "significant", False, False),

    # 41-46: Specific fixture expectations
    ("RBC", 3.76, "4.50 - 5.50", "L", "mil/cumm", "low", "mild", False, False),
    ("Hematocrit", 34.40, "40.0 - 50.0", "L", "%", "low", "mild", False, False),
    ("RDW-CV", 11.50, "11.60 - 14.00", "L", "%", "low", "borderline", False, False),
    ("Random Blood Sugar", 271.0, "70.0 - 140.0", None, "mg/dL", "high", "significant", False, False),
    ("Lymphocyte", 41.0, "20.0 - 40.0", None, "%", "high", "borderline", False, False),
    ("INR", 1.623, "Therapeutic: 2.0-3.0", None, "", "no_range", None, False, False),
]


class TestLabStatusResolutionTableDriven:
    """Commit 3B: Table-driven validation of status resolution, conflicts, and severity."""

    @pytest.mark.parametrize(
        "test_name, val, ref_range, lab_flag, unit, expected_status, expected_severity, expected_conflict, expected_unit_warning",
        TEST_CASES,
    )
    def test_evaluate_result_resolution(
        self,
        test_name: str,
        val: Any,
        ref_range: str | None,
        lab_flag: str | None,
        unit: str,
        expected_status: str,
        expected_severity: str | None,
        expected_conflict: bool,
        expected_unit_warning: bool,
    ):
        res = LabEvaluator.evaluate_result(
            test_name=test_name,
            value=val,
            unit=unit,
            reference_range=ref_range,
            lab_flag=lab_flag,
        )

        assert res["status"] == expected_status, (
            f"Failed status for {test_name}: expected {expected_status}, got {res['status']}"
        )
        assert res.get("severity") == expected_severity, (
            f"Failed severity for {test_name}: expected {expected_severity}, got {res.get('severity')}"
        )
        assert res.get("flag_conflict") == expected_conflict, (
            f"Failed flag_conflict for {test_name}: expected {expected_conflict}, got {res.get('flag_conflict')}"
        )
        assert res.get("unit_warning") == expected_unit_warning, (
            f"Failed unit_warning for {test_name}: expected {expected_unit_warning}, got {res.get('unit_warning')}"
        )
