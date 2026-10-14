from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.core.errors import OcrStageFailureError
from app.modules.ocr.fallback_validator import FallbackOutputValidator
from app.modules.vision.vision_service import build_ocr_prompt
from app.services.pipeline.ocr_stage import (
    has_ocr_failure_placeholders,
    validate_ocr_result,
)


def test_build_ocr_prompt_enforces_script_preservation():
    """Verify that build_ocr_prompt contains strict script preservation rules and advisory hinting."""
    base_prompt = build_ocr_prompt()
    assert "U+0A80-U+0AFF" in base_prompt
    assert "NEVER transliterate" in base_prompt
    assert "Devanagari" in base_prompt

    guj_prompt = build_ocr_prompt("gujarati")
    assert "ADVISORY SCRIPT HINT" in guj_prompt
    assert "Gujarati script (ગુજરાતી)" in guj_prompt
    assert "never mapped to Devanagari/Hindi" in guj_prompt


def test_blank_and_unreadable_declarations_rejected():
    """Verify that conversational refusals on blank or unreadable images trigger failure placeholders."""
    blank_refusal = (
        "The provided image is entirely blank (white background with no visible text or content). "
        "As an accurate OCR engine for medical documents, I must transcribe ALL visible text."
    )
    assert has_ocr_failure_placeholders(blank_refusal) is True

    unreadable_refusal = "The document image has no visible text or writing."
    assert has_ocr_failure_placeholders(unreadable_refusal) is True

    mock_fail_ocr = {
        "fullText": blank_refusal,
        "metrics": {"failed_page_count": 0},
    }
    with pytest.raises(OcrStageFailureError) as exc_info:
        validate_ocr_result(mock_fail_ocr)
    assert exc_info.value.error_code == "OCR_EXTRACTION_FAILED"


def test_legitimate_short_medical_document_accepted():
    """Verify that valid short medical notes are NOT falsely rejected as blank or unreadable."""
    short_prescription = "Dr. Mehta\nBP: 130/80\nTab. Telma 40 1-0-0 30 days"
    assert has_ocr_failure_placeholders(short_prescription) is False

    mock_ok_ocr = {
        "fullText": short_prescription,
        "metrics": {"failed_page_count": 0},
    }
    # Must not raise
    validate_ocr_result(mock_ok_ocr)


def test_gujarati_script_validator_acceptance():
    """Verify that text with authentic Gujarati Unicode characters passes target script validation."""
    validator = FallbackOutputValidator()

    # Synthetic Gujarati prescription text
    guj_sample = (
        "મેમનગર, અમદાવાદ | ફોન: 079-4001111\n"
        "દર્દીનું નામ: શ્રી રમણભાઈ પટેલ | ઉંમર: 56 વર્ષ\n"
        "1. Tab. Glimisave M1 (ગ્લિમીસેવ) - 1-0-0 (30 દિવસ)\n"
        "2. Tab. Telma 40 (ટેલ્મા 40) - 1-0-0 (30 દિવસ)\n"
        "3. Tab. Rosuvas 10 (રોસુવાસ 10) - 0-0-1 (30 દિવસ)\n"
        "4. Tab. Becosules Z - 0-1-0 (30 દિવસ)"
    )

    val_res = validator.validate(guj_sample, expected_script="gujarati")
    assert val_res.is_valid is True
    assert val_res.reason == ""

    # Devanagari-substituted text must be REJECTED under expected_script="gujarati"
    dev_sample = (
        "मेनार्ज, अमारावती | फोन: 096-8000000\n"
        "रोगी का नाम: श्री रामकुमार पुरे | उम्र: 45 वर्ष\n"
        "1. Tab. Glimisave M1 (ग्लिमिसेव M1) - 1-0-0\n"
        "2. Tab. Telma 40 (टेल्मा 40) - 1-0-0"
    )
    val_res_dev = validator.validate(dev_sample, expected_script="gujarati")
    assert val_res_dev.is_valid is False
    assert "SCRIPT_COLLAPSE_NO_GUJARATI_CHARS" in val_res_dev.reason


def test_mixed_script_preservation_validation():
    """Verify that bilingual documents containing both Latin and regional Indic scripts validate properly."""
    validator = FallbackOutputValidator()
    mixed_text = (
        "Hospital: Apollo Clinic\n"
        "Patient: Mohan Lal Verma (મોહનલાલ વર્મા)\n"
        "Rx:\n"
        "1. Metformin 500mg 1-0-1\n"
        "2. Atorvastatin 10mg 0-0-1\n"
        "ફરી મુલાકાત: 15 દિવસ પછી"
    )
    res = validator.validate(mixed_text, expected_script="gujarati")
    assert res.is_valid is True


def test_build_ocr_prompt_enforces_indic_numerals():
    """Verify that build_ocr_prompt contains explicit Indic numeral decoding rules for Gujarati and Devanagari."""
    guj_prompt = build_ocr_prompt("gujarati")
    assert "GUJARATI NUMERAL TRANSCRIPTION RULES" in guj_prompt
    assert "૦=0" in guj_prompt
    assert "૫ represents 5" in guj_prompt
    assert "૬ represents 6" in guj_prompt

    dev_prompt = build_ocr_prompt("devanagari")
    assert "DEVANAGARI NUMERAL TRANSCRIPTION RULES" in dev_prompt
    assert "०=0" in dev_prompt


@pytest.mark.asyncio
async def test_field_evidence_statuses_and_reconciliation():
    """Verify that OcrStageHandler correctly tags fields with VERIFIED, UNCONFIRMED, and UNREADABLE statuses."""
    from app.services.pipeline.ocr_stage import FieldEvidenceStatus, OcrStageHandler
    from PIL import Image
    import io

    # Create dummy image bytes
    img = Image.new("RGB", (1000, 1400), (255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    img_bytes = buf.getvalue()

    vision_mock = AsyncMock()
    handler = OcrStageHandler(s3_client=MagicMock(), vision_service=vision_mock)

    # 1. Unambiguous document (has facility, patient, and age in full text) -> VERIFIED without crop
    clean_text = (
        "સ્ટર્લિંગ હોસ્પિટલ (Sterling Hospital)\n"
        "Patient Name: Ramesh Patel\n"
        "Age: 56 yrs | Gender: Male\n"
        "Tab. Telma 40 1-0-0"
    )
    rec_text, evidence = await handler._inspect_uncertain_regions_if_needed(
        img_bytes=img_bytes,
        page_num=1,
        page_text=clean_text,
        detected_script="gujarati",
        mime="image/png",
    )
    # Proves Requirement 5: zero second pass for unambiguous docs
    vision_mock.extract_image.assert_not_called()
    assert rec_text == clean_text
    assert evidence["facilityName"]["status"] == FieldEvidenceStatus.VERIFIED
    assert evidence["patientIdentity"]["status"] == FieldEvidenceStatus.VERIFIED
    assert evidence["patientAge"]["status"] == FieldEvidenceStatus.VERIFIED


@pytest.mark.asyncio
async def test_targeted_ocr_triggers_on_uncertainty_and_prepends_missing_facility():
    """Verify that when a facility banner is omitted from full-page text, targeted crop discovers and prepends it."""
    from app.services.pipeline.ocr_stage import FieldEvidenceStatus, OcrStageHandler
    from PIL import Image
    import io

    img = Image.new("RGB", (1000, 1400), (255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    img_bytes = buf.getvalue()

    vision_mock = AsyncMock()
    # Mock crop response discovering the top banner
    vision_mock.extract_image = AsyncMock(return_value={
        "text": "સ્ટર્લિંગ મલ્ટીસ્પેશિયાલિટી હોસ્પિટલ\nમેમનગર, અમદાવાદ",
        "confidence": 0.95
    })
    handler = OcrStageHandler(s3_client=MagicMock(), vision_service=vision_mock)

    # Full text missing facility in header
    partial_text = (
        "મેમનગર, ડ્રાઇવ-ઇન રોડ, અમદાવાદ\n"
        "દર્દીનું નામ: શ્રી રમણભાઈ પટેલ | ઉંમર: ૫૬ વર્ષ\n"
        "Tab. Telma 40 1-0-0"
    )

    rec_text, evidence = await handler._inspect_uncertain_regions_if_needed(
        img_bytes=img_bytes,
        page_num=1,
        page_text=partial_text,
        detected_script="gujarati",
        mime="image/png",
    )

    # Targeted crop was invoked
    vision_mock.extract_image.assert_awaited_once()
    # Discovered banner prepended
    assert "સ્ટર્લિંગ મલ્ટીસ્પેશિયાલિટી હોસ્પિટલ" in rec_text
    assert evidence["facilityName"]["status"] == FieldEvidenceStatus.VERIFIED
    assert evidence["facilityName"]["source"] == "header_crop"


@pytest.mark.asyncio
async def test_contradictory_crop_does_not_overwrite_full_page():
    """Verify Requirement 6: Do not automatically overwrite full-page OCR with contradictory crop output."""
    from app.services.pipeline.ocr_stage import FieldEvidenceStatus, OcrStageHandler
    from PIL import Image
    import io

    img = Image.new("RGB", (1000, 1400), (255, 255, 255))
    buf = io.BytesIO()
    img.save(buf, format="PNG")
    img_bytes = buf.getvalue()

    vision_mock = AsyncMock()
    # Crop reports a contradictory age candidate
    vision_mock.extract_image = AsyncMock(return_value={
        "text": "ક્લિનિક\nPatient: John\nAge: 42 yrs",
        "confidence": 0.90
    })
    handler = OcrStageHandler(s3_client=MagicMock(), vision_service=vision_mock)

    full_page_text = "Address: Ahmedabad\nPatient: John\nAge: 56 yrs\nTab. Telma 40"

    rec_text, evidence = await handler._inspect_uncertain_regions_if_needed(
        img_bytes=img_bytes,
        page_num=1,
        page_text=full_page_text,
        detected_script="gujarati",
        mime="image/png",
    )

    # Full-page text age (56 yrs) was NOT overwritten with crop's 42 yrs
    assert "Age: 56 yrs" in rec_text
    # Evidence status marked UNCONFIRMED with conflict_preserved
    assert evidence["patientAge"]["status"] == FieldEvidenceStatus.UNCONFIRMED
    assert evidence["patientAge"]["value"] == "56 yrs"
    assert evidence["patientAge"]["crop_candidate"] == "42 yrs"
    assert evidence["patientAge"]["source"] == "conflict_preserved"
