from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, create_autospec

try:
    from app.core.errors import TranslationError
except ImportError:
    class TranslationError(Exception):
        pass

try:
    from app.services.pipeline.clinical_stage import ClinicalStageHandler, merge_ai_fields
except ImportError:
    from app.services.pipeline.clinical_stage import ClinicalStageHandler
    merge_ai_fields = None

try:
    from app.services.pipeline.summary_stage import (
        SummaryStageHandler,
        summary_is_sane,
    )
except ImportError:
    from app.services.pipeline.summary_stage import SummaryStageHandler
    summary_is_sane = None

from app.services.translation_service import TranslationService


def test_merge_ai_fields_lab_report_keeps_lab_report_and_empties_clinical_lists():
    """For lab reports:
    - documentType stays LAB_REPORT even if AI claims PRESCRIPTION
    - vitals, symptoms, and diagnosis are strictly empty lists
    - no 'None' strings are permitted
    """
    assert merge_ai_fields is not None, "merge_ai_fields function must be implemented"

    structured_base = {
        "documentInfo": {"documentType": "LAB_REPORT", "language": "en", "date": "2025-06-17"},
        "patientInfo": {"fullName": "Manjulaben Ranoliya", "age": 70, "gender": "Female"},
        "providerInfo": {"primary": {"name": "Dr. Hardik", "specialty": None}},
        "facilityInfo": {"name": "Green Cross Genetics Lab", "address": "Junagadh"},
        "diagnosis": [],
        "symptoms": [],
        "vitals": [],
        "labResults": [
            {"testName": "Hemoglobin", "value": 11.2, "unit": "gm%", "status": "low"},
            {"testName": "Patient Value (APTT)", "value": 32.2, "unit": "sec", "status": "normal"},
            {"testName": "Patients Value (PT)", "value": 18.5, "unit": "sec", "status": "high"},
        ],
        "medications": [],
        "additionalInformation": {"extractionPath": "heuristic"},
    }

    # Hallucinated AI output (identical to case 5069200904 raw output)
    ai_extracted = {
        "documentInfo": {"documentType": "PRESCRIPTION", "language": "en"},
        "patientInfo": {"fullName": "Manjulaben Ranoliya", "age": "70", "gender": "Female"},
        "providerInfo": {"primary": {"name": "Dr. HARDIK SUVAGIYA", "specialty": "Patho."}},
        "facilityInfo": {"name": "Green Cross Genetics Lab PVT. LTD.", "address": "Junagadh"},
        "diagnosis": ["Diabetes", "None"],
        "symptoms": ["None"],
        "vitals": [
            {"value": "50", "unit": "Lymphocyte"},
            {"value": "41", "unit": "Eosinophils"},
            {"value": "73", "unit": "Polymorphs"},
        ],
        "labResults": [],
        "medications": ["None"],
    }

    merged = merge_ai_fields(structured_base, ai_extracted)

    # 1. documentType stays LAB_REPORT
    assert merged["documentInfo"]["documentType"] == "LAB_REPORT"

    # 2. vitals, symptoms, and diagnosis MUST be empty for lab reports
    assert merged["vitals"] == []
    assert merged["symptoms"] == []
    assert merged["diagnosis"] == []

    # 3. No "None" strings anywhere
    assert "None" not in merged.get("symptoms", [])
    assert "None" not in merged.get("diagnosis", [])
    assert "None" not in merged.get("medications", [])
    assert "none" not in [str(x).lower() for x in merged.get("symptoms", [])]
    assert "none" not in [str(x).lower() for x in merged.get("diagnosis", [])]


@pytest.mark.asyncio
async def test_clinical_stage_extract_fields_preserves_lab_report_integrity_end_to_end():
    """End-to-end clinical stage test: AI extraction attempting to downgrade to PRESCRIPTION
    and inject differential vitals and symptoms is sanitized."""
    mock_extraction = AsyncMock()
    mock_extraction.chat_model = "medgemma:4b"
    mock_extraction.normalize_structured_ocr.return_value = {
        "documentInfo": {"documentType": "PRESCRIPTION", "language": "en"},
        "patientInfo": {"fullName": "Manjulaben Ranoliya", "age": 70, "gender": "Female"},
        "diagnosis": ["Diabetes"],
        "symptoms": ["None"],
        "vitals": [{"value": "50", "unit": "Lymphocyte"}],
    }

    handler = ClinicalStageHandler(extraction_service=mock_extraction, bypass_min_confidence=0.99)
    raw_ocr = {
        "fullText": (
            "Green Cross Genetics Lab PVT. LTD.\n"
            "LABORATORY REPORT\n"
            "Name: Manjulaben Ranoliya  Age: 70 Years  Sex: Female\n"
            "Case ID: 5069200904\n"
            "COMPLETE BLOOD COUNT (CBC)\n"
            "Hemoglobin: 11.20 gm%\n"
            "Patient Value (APTT): 32.2 sec\n"
        ),
        "paragraphs": [],
    }
    layout = {
        "tables": [
            {
                "headers": ["Investigation", "Result", "Unit", "Reference Interval"],
                "rows": [["Hemoglobin", "11.20", "gm%", "12 - 15"]],
            }
        ]
    }

    result = await handler.extract_fields(raw_ocr, layout)

    assert result["documentInfo"]["documentType"] == "LAB_REPORT"
    assert result["vitals"] == []
    assert result["symptoms"] == []
    assert result["diagnosis"] == []
    assert "None" not in result["symptoms"]


def test_summary_gate_rejects_stringified_json_dict():
    """Summary gate summary_is_sane must reject stringified python dicts / json like {'type': ...}."""
    assert summary_is_sane is not None, "summary_is_sane must be implemented"
    structured = {
        "labResults": [
            {"testName": "Hemoglobin", "value": 11.2, "status": "low"},
        ]
    }
    hallucinated_dict_summary = "{'type': 'CBC', 'summary': [{'type': 'Hemoglobin', 'summary': []}]}"
    assert summary_is_sane(hallucinated_dict_summary, structured) is False

    valid_summary = "Patient's hemoglobin is mildly low at 11.2 gm%. No other critical acute findings noted."
    assert summary_is_sane(valid_summary, structured) is True


def test_summary_gate_rejects_aptt_is_high_when_aptt_is_normal():
    """Summary gate summary_is_sane must reject 'APTT is high' when APTT is clinically normal."""
    assert summary_is_sane is not None, "summary_is_sane must be implemented"
    structured = {
        "labResults": [
            {"testName": "Patient Value (APTT)", "value": 32.2, "unit": "sec", "status": "normal", "isAbnormal": False},
            {"testName": "Patients Value (PT)", "value": 18.5, "unit": "sec", "status": "high", "isAbnormal": True},
        ]
    }

    hallucinated_aptt_high = "The report shows that APTT is high (18.5 seconds) while PT is elevated."
    assert summary_is_sane(hallucinated_aptt_high, structured) is False

    valid_summary = "Patients Value (PT) is elevated at 18.5 sec, while APTT is within normal limits at 32.2 sec."
    assert summary_is_sane(valid_summary, structured) is True


@pytest.mark.asyncio
async def test_summary_stage_rejects_insane_summary_and_falls_back():
    """When the summary service returns raw dict or APTT-is-high hallucination,
    SummaryStageHandler falls back to deterministic clinical summary."""
    mock_summary = AsyncMock()
    mock_summary.summarize.return_value = {
        "summary": ["{'type': 'CBC', 'summary': [{'type': 'Hemoglobin'}]}"]
    }

    handler = SummaryStageHandler(summary_service=mock_summary, translation_service=None)
    structured = {
        "documentInfo": {"documentType": "LAB_REPORT"},
        "labResults": [
            {"testName": "Hemoglobin", "value": 11.2, "unit": "gm%", "status": "low", "severity": "mild", "isAbnormal": True},
            {"testName": "Patient Value (APTT)", "value": 32.2, "unit": "sec", "status": "normal", "isAbnormal": False},
        ],
        "diagnosis": [],
        "medications": [],
    }

    res = await handler.generate_summary(raw_text="Sample raw text", structured_data=structured)

    # Must NOT contain stringified dict
    assert "{'type'" not in res["summaryEnglish"]
    assert "Hemoglobin is 11.2 gm% [low" in res["summaryEnglish"]


@pytest.mark.asyncio
async def test_translation_autospec_kwarg_fix_and_failure_fallback():
    """Uses create_autospec(TranslationService) to verify:
    1. translate() is called with correct kwargs (src_lang, tgt_lang) matching TranslationService signature
    2. TranslationError or failure sets summaryLanguage='english' and translationStatus='FAILED'
    """
    spec_mock = create_autospec(TranslationService, instance=True)
    spec_mock.is_warm = True

    # Configure side effect to raise TranslationError on translation attempt
    spec_mock.translate = AsyncMock(side_effect=TranslationError("IndicTrans2 inference failed"))

    handler = SummaryStageHandler(summary_service=None, translation_service=spec_mock)
    structured = {
        "documentInfo": {"documentType": "LAB_REPORT"},
        "labResults": [
            {"testName": "Hemoglobin", "value": 11.2, "unit": "gm%", "status": "low", "severity": "mild", "isAbnormal": True}
        ],
        "diagnosis": [],
        "medications": [],
    }

    res = await handler.generate_summary(
        raw_text="Hemoglobin 11.2 gm%",
        structured_data=structured,
        preferred_language="gujarati",
    )

    # Verify translate was called with src_lang and tgt_lang (matching TranslationService signature)
    spec_mock.translate.assert_awaited_once_with(
        text=res["summaryEnglish"],
        src_lang="english",
        tgt_lang="gujarati",
    )

    # On failure, summaryLanguage must revert to "english" and translationStatus must be "FAILED"
    assert res["summaryLanguage"] == "english"
    assert res["translationStatus"] == "FAILED"
    assert res["summaryInPreferredLanguage"] == res["summaryEnglish"]


@pytest.mark.asyncio
async def test_translation_autospec_success():
    """When translation succeeds, summaryLanguage is target language and translationStatus is 'SUCCESS'."""
    spec_mock = create_autospec(TranslationService, instance=True)
    spec_mock.is_warm = True
    spec_mock.translate = AsyncMock(
        return_value="દર્દીનું હિમોગ્લોબિન ઓછું છે (11.2 gm%)."
    )

    handler = SummaryStageHandler(summary_service=None, translation_service=spec_mock)
    structured = {
        "documentInfo": {"documentType": "LAB_REPORT"},
        "labResults": [
            {"testName": "Hemoglobin", "value": 11.2, "unit": "gm%", "status": "low", "severity": "mild", "isAbnormal": True}
        ],
        "diagnosis": [],
        "medications": [],
    }

    res = await handler.generate_summary(
        raw_text="Hemoglobin 11.2 gm%",
        structured_data=structured,
        preferred_language="gujarati",
    )

    spec_mock.translate.assert_awaited_once_with(
        text=res["summaryEnglish"],
        src_lang="english",
        tgt_lang="gujarati",
    )

    assert res["summaryLanguage"] == "gujarati"
    assert res["translationStatus"] == "SUCCESS"
    assert res["summaryInPreferredLanguage"] == "દર્દીનું હિમોગ્લોબિન ઓછું છે (11.2 gm%)."
