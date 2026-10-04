import pytest
from app.modules.ocr.fallback_validator import FallbackOutputValidator, FallbackValidationResult
from app.services.pipeline.ocr_stage import OcrStageHandler


def test_detect_degenerate_loops_consecutive_lines():
    validator = FallbackOutputValidator(max_consecutive_repeated_lines=3)

    # 3 identical consecutive lines
    loop_text = (
        "Patient Name: John Doe\n"
        "CBC REPORT\n"
        "CBC REPORT\n"
        "CBC REPORT\n"
        "Hemoglobin: 14 g/dL"
    )
    is_loop, snippet = validator.detect_degenerate_loops(loop_text)
    assert is_loop is True
    assert "CBC REPORT" in snippet

    # Normal text without repetition
    normal_text = (
        "Patient Name: John Doe\n"
        "Age: 45\n"
        "CBC REPORT\n"
        "Hemoglobin: 14 g/dL\n"
        "Platelets: 250,000"
    )
    is_loop, _ = validator.detect_degenerate_loops(normal_text)
    assert is_loop is False


def test_detect_degenerate_loops_cyclic_ngram():
    validator = FallbackOutputValidator(max_repeated_ngram_cycles=4)

    # Repeating phrase pattern 4 times
    loop_text = (
        "Laboratory Findings: "
        "Normal Range Reference Interval "
        "Normal Range Reference Interval "
        "Normal Range Reference Interval "
        "Normal Range Reference Interval "
        "End of report"
    )
    is_loop, snippet = validator.detect_degenerate_loops(loop_text)
    assert is_loop is True
    assert "Cyclic pattern" in snippet

    # Normal text
    normal_text = "Patient underwent routine clinical evaluation. Fasting glucose was 95 mg/dL. HbA1c was 5.6%."
    is_loop, _ = validator.detect_degenerate_loops(normal_text)
    assert is_loop is False


def test_validate_target_script():
    validator = FallbackOutputValidator()

    # Gujarati expected: text with Gujarati characters passes
    guj_text = "દર્દીનું નામ: રાજેશ શર્મા, ઉંમર: ૪૫ વર્ષ"
    valid, share, reason = validator.validate_target_script(guj_text, expected_script="gujarati")
    assert valid is True
    assert share > 0.50
    assert reason == ""

    # Gujarati expected: text with purely English hallucination/translation fails
    en_only_text = "Patient Name: Rajesh Sharma, Age: 45 Years, Blood Test Report"
    valid, share, reason = validator.validate_target_script(en_only_text, expected_script="gujarati")
    assert valid is False
    assert share == 0.0
    assert "NO_GUJARATI_CHARS" in reason

    # Devanagari expected: Hindi text passes
    hi_text = "रोगी का नाम: राजेश शर्मा, रक्त परीक्षण"
    valid, share, reason = validator.validate_target_script(hi_text, expected_script="devanagari")
    assert valid is True
    assert share > 0.50

    # No expected script or Latin script: passes unconditionally
    valid, share, reason = validator.validate_target_script(en_only_text, expected_script="latin")
    assert valid is True


def test_validate_termination():
    validator = FallbackOutputValidator(min_chars=10)

    # Empty response
    valid, reason = validator.validate_termination("", finish_reason="stop")
    assert valid is False
    assert reason == "EMPTY_RESPONSE"

    # Whitespace only
    valid, reason = validator.validate_termination("   \n\t  ", finish_reason="stop")
    assert valid is False
    assert reason == "EMPTY_RESPONSE"

    # Premature length truncation (< 10 chars with finish_reason="length")
    valid, reason = validator.validate_termination("Patient", finish_reason="length")
    assert valid is False
    assert reason == "PREMATURE_LENGTH_TERMINATION"

    # Valid response
    valid, reason = validator.validate_termination("Patient Name: Rajesh Sharma", finish_reason="stop")
    assert valid is True
    assert reason == ""


def test_apply_vision_result_rejects_degenerate_loop():
    """Verify that _apply_vision_result rejects degenerate VLM loops and recovers cleanly."""
    handler = OcrStageHandler(
        s3_client=None,
        lifecycle=None,
        vision_service=None,
        paddle_engine=None,
        quality_gate=None,
    )

    paddle_res = {
        "lines": [
            {"text": "CITY HOSPITAL REPORT", "confidence": 0.95},
            {"text": "Patient Name: Rajesh Sharma", "confidence": 0.92},
        ],
    }

    # Degenerate repeating loop from VLM
    vision_res = {
        "text": "LOOP LINE\nLOOP LINE\nLOOP LINE\nLOOP LINE\nLOOP LINE",
        "confidence": 0.95,
        "finish_reason": "length",
    }

    page_text, conf, lines, engine_used, status = handler._apply_vision_result(
        res=vision_res,
        paddle_res=paddle_res,
        fallback_reason="UNREAD_NON_LATIN_SCRIPT",
    )

    # Loop is rejected; Paddle's valid lines are retained
    assert engine_used == "paddleocr_partial"
    assert status == "FALLBACK_PARTIAL"
    assert "LOOP LINE" not in page_text
    assert "CITY HOSPITAL REPORT" in page_text
    assert "Rajesh Sharma" in page_text


def test_apply_vision_result_rejects_script_collapse():
    """Verify that _apply_vision_result rejects output with 0 target script characters when non-Latin expected."""
    handler = OcrStageHandler(
        s3_client=None,
        lifecycle=None,
        vision_service=None,
        paddle_engine=None,
        quality_gate=None,
    )

    paddle_res = None

    # VLM collapsed into English translation instead of verbatim Gujarati transcription
    vision_res = {
        "text": "Patient Name: Rajesh Sharma\nAge: 45 Years\nBlood Glucose: 110",
        "confidence": 0.95,
        "finish_reason": "stop",
    }

    page_text, conf, lines, engine_used, status = handler._apply_vision_result(
        res=vision_res,
        paddle_res=paddle_res,
        fallback_reason="UNREAD_NON_LATIN_SCRIPT",
        expected_script="gujarati",
    )

    assert status.startswith("FAILED")
    assert "NO_GUJARATI_CHARS" in status
    assert page_text == ""
    assert lines == []
