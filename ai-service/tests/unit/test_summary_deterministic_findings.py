from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.services.pipeline.summary_stage import (
    SummaryStageHandler,
    build_deterministic_key_findings,
    format_abnormal_findings_prompt,
    verify_abnormal_parameters_present,
)


def test_build_deterministic_key_findings_includes_abnormal_and_borderline_excludes_normal_and_info():
    """Commit 3E: key_findings built in code from abnormal + borderline parameters."""
    structured_data = {
        "labResults": [
            {
                "testName": "Hemoglobin",
                "value": 11.20,
                "unit": "gm%",
                "status": "low",
                "severity": "mild",
                "referenceRange": "13.0 - 17.0",
                "isAbnormal": True,
            },
            {
                "testName": "RBC Count",
                "value": 3.76,
                "unit": "mil/cumm",
                "status": "low",
                "severity": "mild",
                "referenceRange": "4.5 - 5.5",
                "isAbnormal": True,
            },
            {
                "testName": "Random Blood Sugar",
                "value": 271.0,
                "unit": "mg/dL",
                "status": "high",
                "severity": "significant",
                "referenceRange": "70 - 140",
                "isAbnormal": True,
            },
            {
                "testName": "HbA1c",
                "value": 9.0,
                "unit": "%",
                "status": "diabetic",
                "severity": None,
                "referenceRange": "< 5.7",
                "isAbnormal": True,
            },
            {
                "testName": "Lymphocyte",
                "value": 41.0,
                "unit": "%",
                "status": "high",
                "severity": "borderline",
                "referenceRange": "20 - 40",
                "isAbnormal": True,
            },
            # Normal parameters (must be excluded)
            {
                "testName": "WBC Count",
                "value": 7500,
                "unit": "/cumm",
                "status": "normal",
                "severity": None,
                "referenceRange": "4000 - 11000",
                "isAbnormal": False,
            },
            {
                "testName": "Platelet Count",
                "value": 250000,
                "unit": "/cumm",
                "status": "normal",
                "severity": None,
                "referenceRange": "150000 - 450000",
                "isAbnormal": False,
            },
            # Informational parameter (must be excluded)
            {
                "testName": "Mean Plasma Glucose",
                "value": 212.20,
                "unit": "mg/dL",
                "status": "info",
                "is_informational": True,
                "severity": None,
                "referenceRange": "mg/dL",
                "isAbnormal": False,
            },
            # No range parameter (must be excluded)
            {
                "testName": "INR",
                "value": 1.623,
                "unit": "",
                "status": "no_range",
                "severity": None,
                "referenceRange": "See lab reference",
                "isAbnormal": False,
            },
        ]
    }

    findings = build_deterministic_key_findings(structured_data)
    assert len(findings) == 5

    names = [f["testName"] for f in findings]
    assert "Hemoglobin" in names
    assert "RBC Count" in names
    assert "Random Blood Sugar" in names
    assert "HbA1c" in names
    assert "Lymphocyte" in names
    assert "WBC Count" not in names
    assert "Platelet Count" not in names
    assert "Mean Plasma Glucose" not in names
    assert "INR" not in names

    # Verify field contents
    hb = next(f for f in findings if f["testName"] == "Hemoglobin")
    assert hb["value"] == 11.20
    assert hb["unit"] == "gm%"
    assert hb["status"] == "low"
    assert hb["severity"] == "mild"
    assert hb["referenceRange"] == "13.0 - 17.0"


def test_format_abnormal_findings_prompt():
    """Commit 3E: Prompt explicitly lists abnormal tests and instructs summary to explain each."""
    findings = [
        {
            "testName": "Hemoglobin",
            "value": 11.20,
            "unit": "gm%",
            "status": "low",
            "severity": "mild",
            "referenceRange": "13.0 - 17.0",
        },
        {
            "testName": "Random Blood Sugar",
            "value": 271.0,
            "unit": "mg/dL",
            "status": "high",
            "severity": "significant",
            "referenceRange": "70 - 140",
        },
    ]

    prompt_snippet = format_abnormal_findings_prompt(findings)
    assert "The following tests are abnormal:" in prompt_snippet
    assert "Your summary MUST explain each of these." in prompt_snippet
    assert "Hemoglobin" in prompt_snippet
    assert "11.2" in prompt_snippet
    assert "gm%" in prompt_snippet
    assert "low" in prompt_snippet
    assert "Random Blood Sugar" in prompt_snippet
    assert "271" in prompt_snippet
    assert "high" in prompt_snippet


def test_verify_abnormal_parameters_present():
    """Commit 3E: Verification check detects missing abnormal parameters in summary."""
    findings = [
        {"testName": "Hemoglobin", "value": 11.20, "unit": "gm%"},
        {"testName": "Random Blood Sugar", "value": 271.0, "unit": "mg/dL"},
        {"testName": "Patients Value (PT)", "value": 18.5, "unit": "Sec"},
    ]

    # All present
    summary_good = (
        "Patient shows mild anemia with Hemoglobin at 11.20 gm%. Blood sugar is elevated at 271 mg/dL, "
        "and Prothrombin Time (PT) is prolonged at 18.5 seconds."
    )
    is_valid, missing = verify_abnormal_parameters_present(findings, summary_good)
    assert is_valid is True
    assert len(missing) == 0

    # Random blood sugar omitted
    summary_omitted = (
        "Patient shows mild anemia with Hemoglobin at 11.20 gm%. Prothrombin Time (PT) is prolonged at 18.5 seconds."
    )
    is_valid, missing = verify_abnormal_parameters_present(findings, summary_omitted)
    assert is_valid is False
    assert "Random Blood Sugar" in missing


@pytest.mark.asyncio
async def test_summary_retries_once_when_abnormal_parameter_missing():
    """Commit 3E: If abnormal parameter is missing, retries once with LLM."""
    structured_data = {
        "labResults": [
            {
                "testName": "Hemoglobin",
                "value": 11.20,
                "unit": "gm%",
                "status": "low",
                "severity": "mild",
                "referenceRange": "13.0 - 17.0",
                "isAbnormal": True,
            },
            {
                "testName": "Random Blood Sugar",
                "value": 271.0,
                "unit": "mg/dL",
                "status": "high",
                "severity": "significant",
                "referenceRange": "70 - 140",
                "isAbnormal": True,
            },
        ]
    }

    # First call omits Random Blood Sugar; second call (retry) includes it
    mock_summary_service = MagicMock()
    mock_summary_service.summarize = AsyncMock(
        side_effect=[
            {"summary": ["Patient has low Hemoglobin (11.2 gm%)."]},
            {"summary": ["Patient has low Hemoglobin (11.2 gm%) and elevated Random Blood Sugar (271 mg/dL)."]},
        ]
    )

    handler = SummaryStageHandler(summary_service=mock_summary_service, translation_service=None)
    result = await handler.generate_summary(
        raw_text="Hemoglobin 11.2, Random Blood Sugar 271",
        structured_data=structured_data,
        preferred_language="english",
    )

    assert mock_summary_service.summarize.call_count == 2
    assert "Hemoglobin" in result["summaryEnglish"]
    assert "Random Blood Sugar" in result["summaryEnglish"]
    assert len(result["keyFindings"]) == 2


@pytest.mark.asyncio
async def test_summary_falls_back_to_deterministic_text_when_retry_still_omits_abnormal_parameter():
    """Commit 3E: If retry still misses abnormal parameter, falls back to deterministic structured text."""
    structured_data = {
        "labResults": [
            {
                "testName": "Hemoglobin",
                "value": 11.20,
                "unit": "gm%",
                "status": "low",
                "severity": "mild",
                "referenceRange": "13.0 - 17.0",
                "isAbnormal": True,
            },
            {
                "testName": "Random Blood Sugar",
                "value": 271.0,
                "unit": "mg/dL",
                "status": "high",
                "severity": "significant",
                "referenceRange": "70 - 140",
                "isAbnormal": True,
            },
        ]
    }

    # Both calls omit Random Blood Sugar
    mock_summary_service = MagicMock()
    mock_summary_service.summarize = AsyncMock(
        side_effect=[
            {"summary": ["Patient has low Hemoglobin (11.2 gm%)."]},
            {"summary": ["Patient has low Hemoglobin (11.2 gm%) and feels tired."]},
        ]
    )

    handler = SummaryStageHandler(summary_service=mock_summary_service, translation_service=None)
    result = await handler.generate_summary(
        raw_text="Hemoglobin 11.2, Random Blood Sugar 271",
        structured_data=structured_data,
        preferred_language="english",
    )

    # 2 calls made (attempt + 1 retry), then fallback to deterministic summary
    assert mock_summary_service.summarize.call_count == 2
    assert "Random Blood Sugar" in result["summaryEnglish"]
    assert "271" in result["summaryEnglish"]
    assert "Hemoglobin" in result["summaryEnglish"]
    assert "11.2" in result["summaryEnglish"]
    assert len(result["keyFindings"]) == 2


@pytest.mark.asyncio
async def test_summary_on_fixture_pdf_builds_key_findings_for_all_8_abnormal_fixture_parameters():
    """Commit 3E: Full pipeline extraction on fixture PDF yields 8 abnormal key findings."""
    from pathlib import Path
    import fitz
    from app.services.pipeline.ocr_stage import OcrStageHandler
    from app.services.pipeline.lab_evaluator import LabEvaluator

    fixture_pdf = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "real_6page_digital.pdf"
    doc = fitz.open(fixture_pdf)
    extracted_params = OcrStageHandler.extract_spatial_parameters(doc)
    evaluated = LabEvaluator.evaluate_all(extracted_params)

    structured_data = {
        "labResults": evaluated,
        "patientInfo": {"name": "Patient"},
        "doctorInfo": {"name": "Dr. HARDIK SUVAGIYA"},
    }

    handler = SummaryStageHandler(summary_service=None, translation_service=None)
    result = await handler.generate_summary(
        raw_text="",
        structured_data=structured_data,
        preferred_language="english",
    )

    findings = result["keyFindings"]
    assert len(findings) == 9, f"Expected 9 abnormal/borderline findings, got {len(findings)}: {[f['testName'] for f in findings]}"

    finding_names = [f["testName"] for f in findings]
    assert "Hemoglobin" in finding_names
    assert "RBC Count" in finding_names
    assert "Hematocrit/PCV" in finding_names
    assert "RDW-CV" in finding_names
    assert "Random Blood Sugar" in finding_names
    assert "Hba1c" in finding_names
    assert "Patients Value (PT)" in finding_names
    assert "Lymphocyte" in finding_names
    assert "INR" in finding_names

    # Check that deterministic summary contains all of them
    summary_text = result["summaryEnglish"]
    for name in finding_names:
        assert name in summary_text, f"Missing {name} in summary text"
