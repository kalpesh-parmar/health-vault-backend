from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.services.translation_service import (
    TranslationService,
    mask_text,
    unmask_text,
    validate_placeholder_integrity,
)
from app.services.pipeline.summary_stage import (
    SummaryStageHandler,
    extract_key_bullet_points,
    strip_think_tokens,
)
from app.settings import Settings


@pytest.fixture
def dummy_settings():
    return Settings(
        translation_model="qwen2.5:14b",
        translation_provider="auto",
    )


@pytest.mark.asyncio
async def test_indictrans2_primary_success(dummy_settings):
    ts = TranslationService(dummy_settings)
    ts.is_en_indic_warm = True
    ts.is_warm = True

    ts._translate_with_indictrans2 = AsyncMock(
        return_value="દર્દીનું બ્લડ પ્રેશર વધ્યું છે. Metformin 500mg દિવસમાં બે વાર લો."
    )

    res = await ts.translate_with_metadata(
        "The patient has elevated blood pressure. Take Metformin 500mg twice daily.",
        "english",
        "gujarati",
    )

    assert res["status"] == "SUCCESS"
    assert res["provider"] == "indictrans2"
    assert res["target_language"] == "gujarati"
    assert "Metformin 500mg" in res["translated_text"]
    assert res["error"] is None


@pytest.mark.asyncio
async def test_ollama_fallback_when_indictrans2_fails(dummy_settings):
    mock_llm = MagicMock()
    mock_llm.chat = AsyncMock(
        return_value="દર્દીનું બ્લડ પ્રેશર વધ્યું છે. ⟦1⟧ ⟦2⟧ દિવસમાં બે વાર લો."
    )

    ts = TranslationService(dummy_settings, llm_service=mock_llm)
    ts.is_en_indic_warm = True
    ts.is_warm = True

    # IndicTrans2 fails with an error
    ts._translate_with_indictrans2 = AsyncMock(side_effect=RuntimeError("CUDA OOM or model crash"))

    res = await ts.translate_with_metadata(
        "The patient has elevated blood pressure. Take Metformin 500mg twice daily.",
        "english",
        "gujarati",
    )

    assert res["status"] == "SUCCESS"
    assert res["provider"] == "ollama"
    assert res["target_language"] == "gujarati"
    assert "Metformin" in res["translated_text"]
    assert "500mg" in res["translated_text"]


@pytest.mark.asyncio
async def test_explicit_fallback_metadata_when_all_fail(dummy_settings):
    mock_llm = MagicMock()
    mock_llm.chat = AsyncMock(side_effect=RuntimeError("Ollama connection refused"))

    ts = TranslationService(dummy_settings, llm_service=mock_llm)
    ts.is_en_indic_warm = True
    ts.is_warm = True

    ts._translate_with_indictrans2 = AsyncMock(side_effect=RuntimeError("IndicTrans2 failed"))

    original_english = "The patient has elevated blood pressure. Take Metformin 500mg twice daily."
    res = await ts.translate_with_metadata(
        original_english,
        "english",
        "tamil",
    )

    assert res["status"] == "FALLBACK_ORIGINAL"
    assert res["provider"] == "none"
    assert res["target_language"] == "english"
    assert res["translated_text"] == original_english
    assert "Ollama error" in res["error"]


@pytest.mark.asyncio
async def test_marathi_vs_hindi_marker_evaluation(dummy_settings):
    ts = TranslationService(dummy_settings)

    hindi_output = "रोगी का रक्तचाप बढ़ गया है। 500 मिलीग्राम मेटफॉर्मिन दिन में दो बार लें।"
    marathi_output = "रुग्णाला उच्च रक्तदाब आहे. मेटफॉर्मिन 500 मिलीग्राम दिवसातून दोनदा घ्या."

    # When target is Marathi, but output has Hindi markers:
    valid, reason = await ts.validate_translation(
        "The patient has high BP. Take Metformin 500mg twice daily.",
        hindi_output,
        "marathi",
    )
    assert valid is False
    assert "Hindi rather than Marathi" in reason or "Language check failed" in reason

    # When target is Marathi, and output has Marathi markers:
    valid_mr, _ = await ts.validate_translation(
        "The patient has high BP. Take Metformin 500mg twice daily.",
        marathi_output,
        "marathi",
    )
    assert valid_mr is True

    # When target is Hindi, and output has Hindi markers:
    valid_hi, _ = await ts.validate_translation(
        "The patient has high BP. Take Metformin 500mg twice daily.",
        hindi_output,
        "hindi",
    )
    assert valid_hi is True


@pytest.mark.asyncio
async def test_summary_stage_handler_metadata_integration():
    mock_trans = MagicMock()
    mock_trans.is_warm = True
    meta_payload = {
        "translated_text": "દર્દીને Metformin 500mg લેવાની સલાહ આપવામાં આવે છે.",
        "provider": "indictrans2",
        "status": "SUCCESS",
        "target_language": "gujarati",
        "error": None,
    }
    mock_trans.translate = AsyncMock(return_value=meta_payload["translated_text"])
    mock_trans.last_metadata = meta_payload

    handler = SummaryStageHandler(summary_service=None, translation_service=mock_trans)

    structured = {
        "diagnosis": ["Hypertension"],
        "medications": [{"name": "Metformin 500mg", "frequency": "1-0-1"}],
        "labResults": [],
    }

    raw_text = "Patient diagnosed with Hypertension. Prescribed Metformin 500mg daily."
    result = await handler.generate_summary(
        raw_text=raw_text,
        structured_data=structured,
        preferred_language="gujarati",
    )

    assert result["summaryLanguage"] == "gujarati"
    assert result["translationStatus"] == "SUCCESS"
    assert result["translationProvider"] == "indictrans2"
    assert "500mg" in result["summaryEnglish"]
    assert "Metformin 500mg" in result["summaryInPreferredLanguage"]
    assert result["dosagePreserved"] is True
    mock_trans.translate.assert_awaited_once_with(
        text=result["summaryEnglish"],
        src_lang="english",
        tgt_lang="gujarati",
    )


@pytest.mark.asyncio
async def test_summary_stage_handler_english_noop():
    mock_trans = MagicMock()
    mock_trans.translate = AsyncMock()
    handler = SummaryStageHandler(summary_service=None, translation_service=mock_trans)

    structured = {
        "diagnosis": ["Hypertension"],
        "medications": [{"name": "Metformin 500mg", "frequency": "1-0-1"}],
        "labResults": [],
    }

    raw_text = "Patient diagnosed with Hypertension. Prescribed Metformin 500mg daily."
    result = await handler.generate_summary(
        raw_text=raw_text,
        structured_data=structured,
        preferred_language="english",
    )

    assert result["summaryLanguage"] == "english"
    assert result["translationStatus"] == "SUCCESS"
    assert result["translationProvider"] == "none"
    assert result["summaryInPreferredLanguage"] == result["summaryEnglish"]
    mock_trans.translate.assert_not_called()
