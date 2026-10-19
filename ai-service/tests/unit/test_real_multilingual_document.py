from __future__ import annotations

import pytest
from app.services.translation_service import TranslationService
from app.services.pipeline.summary_stage import SummaryStageHandler
from app.settings import Settings

REAL_MEDICAL_DOCUMENT_SUMMARY = (
    "Patient is diagnosed with Type 2 Diabetes Mellitus and Hypertension. "
    "Lab results show HbA1c at 8.2% and Blood Pressure at 140/90 mmHg. "
    "Prescribed Metformin 500mg twice daily (1-0-1) and Telmisartan 40mg once daily."
)

STRUCTURED_DATA = {
    "diagnosis": ["Type 2 Diabetes Mellitus", "Hypertension"],
    "medications": [
        {"name": "Metformin", "dosage": "500mg", "frequency": "1-0-1"},
        {"name": "Telmisartan", "dosage": "40mg", "frequency": "1-0-0"},
    ],
    "labResults": [
        {"testName": "HbA1c", "value": "8.2", "unit": "%", "status": "high", "flag": "HIGH"},
        {"testName": "Blood Pressure", "value": "140/90", "unit": "mmHg", "status": "abnormal"},
    ],
}


@pytest.fixture(scope="module")
def real_translation_service():
    settings = Settings()
    ts = TranslationService(settings)
    # Synchronous warmup or async warmup in first test
    return ts


@pytest.mark.asyncio
async def test_real_medical_document_translation_warmup(real_translation_service):
    await real_translation_service.warm_up()
    assert real_translation_service.is_en_indic_warm is True


@pytest.mark.asyncio
@pytest.mark.parametrize("target_lang,expected_script_range", [
    ("hindi", (0x0900, 0x097F)),
    ("gujarati", (0x0A80, 0x0AFF)),
    ("marathi", (0x0900, 0x097F)),
    ("tamil", (0x0B80, 0x0BFF)),
])
async def test_real_medical_document_translation_indictrans2(
    real_translation_service,
    target_lang,
    expected_script_range,
):
    if not real_translation_service.is_en_indic_warm:
        await real_translation_service.warm_up()

    meta = await real_translation_service.translate_with_metadata(
        REAL_MEDICAL_DOCUMENT_SUMMARY,
        src_lang="english",
        tgt_lang=target_lang,
    )

    assert meta["status"] == "SUCCESS"
    assert meta["provider"] == "indictrans2"
    assert meta["target_language"] == target_lang
    assert meta["error"] is None

    translated_text = meta["translated_text"]
    assert translated_text != REAL_MEDICAL_DOCUMENT_SUMMARY

    # Check that appropriate Indic script characters are present
    low, high = expected_script_range
    indic_chars = [c for c in translated_text if low <= ord(c) <= high]
    assert len(indic_chars) > 20

    # Ensure critical numbers and dosages are preserved
    assert "500" in translated_text
    assert "40" in translated_text


@pytest.mark.asyncio
async def test_real_medical_document_summary_pipeline_integration(real_translation_service):
    if not real_translation_service.is_en_indic_warm:
        await real_translation_service.warm_up()

    handler = SummaryStageHandler(
        summary_service=None,
        translation_service=real_translation_service,
    )

    res = await handler.generate_summary(
        raw_text=REAL_MEDICAL_DOCUMENT_SUMMARY,
        structured_data=STRUCTURED_DATA,
        preferred_language="hindi",
    )

    assert res["summaryEnglish"] is not None
    assert len(res["summaryEnglish"]) > 0
    assert res["summaryLanguage"] == "hindi"
    assert res["translationStatus"] == "SUCCESS"
    assert res["translationProvider"] == "indictrans2"
    assert res["summaryInPreferredLanguage"] != res["summaryEnglish"]
    assert res["dosagePreserved"] is True
