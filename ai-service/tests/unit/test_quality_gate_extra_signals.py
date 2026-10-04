from __future__ import annotations

import pytest
from app.modules.ocr.quality_gate import QualityGate, QualityGateResult


def test_quality_gate_rejects_fragmented_symbol_noise_with_high_confidence():
    """Assert rejection of fragmented symbol noise even when synthetic confidence is high (>0.90)."""
    gate = QualityGate()
    # High confidence, but each token is a single fragmented character
    noisy_fragments = "a b c d e f g h i j k l m n o p q r s t u v w x y z"
    fragment_result = {
        "lines": [
            {"text": "a b c d e f g h i j k l m", "confidence": 0.94},
            {"text": "n o p q r s t u v w x y z", "confidence": 0.96},
        ],
        "full_text": noisy_fragments,
        "mean_confidence": 0.95,
        "min_confidence": 0.94,
        "line_count": 2,
        "char_count": len(noisy_fragments),
    }

    result = gate.evaluate(fragment_result)
    assert result.passed is False
    assert result.details["fragment_ratio"] > 0.35
    assert (
        "EXCESSIVE_TOKEN_FRAGMENTATION" in result.reason
        or "LOW_AVERAGE_TOKEN_LENGTH" in result.reason
    )


def test_quality_gate_accepts_dense_numeric_lab_reports():
    """Assert acceptance of dense numeric lab reports with columns of single numbers (5, 14.5, fl, %)."""
    gate = QualityGate()
    lines = [
        {"text": "Complete Blood Count Investigation Report", "confidence": 0.96},
        {"text": "Patient Name: Jane Doe Age: 34 Gender: Female", "confidence": 0.95},
        {"text": "Hemoglobin 14.5 g/dl Normal Range: 12.0 - 15.5", "confidence": 0.94},
        {"text": "WBC Count 5.2 thou/cumm Range: 4.0 - 11.0", "confidence": 0.95},
        {"text": "Neutrophils 65 % Range: 40 - 75 %", "confidence": 0.93},
        {"text": "Lymphocytes 28 % Range: 20 - 45 %", "confidence": 0.94},
        {"text": "Platelet Count 250 thou/cumm Range: 150 - 450", "confidence": 0.95},
        {"text": "MCV 88.0 fl Range: 80 - 100", "confidence": 0.92},
        {"text": "MCH 30.5 pg Range: 27 - 33", "confidence": 0.93},
        {"text": "Eosinophils 3 % Basophils 1 % Monocytes 5 %", "confidence": 0.91},
    ]
    full_text = "\n".join(l["text"] for l in lines)
    lab_result = {
        "lines": lines,
        "full_text": full_text,
        "mean_confidence": 0.938,
        "min_confidence": 0.91,
        "line_count": len(lines),
        "char_count": len(full_text),
    }

    result = gate.evaluate(lab_result)
    assert result.passed is True
    assert result.reason == "Quality gate passed"
    assert result.details["fragment_ratio"] <= 0.35
    assert result.details["avg_token_len"] >= 2.5
    assert result.details["valid_token_ratio"] >= 0.35


def test_quality_gate_rejects_pseudo_latin_garble_strings():
    """Assert rejection of unpronounceable pseudo-Latin garble strings (LFkku izfr vLirky)."""
    gate = QualityGate()
    # High confidence garble produced by legacy font / misrouted Indic text
    garble_text = "LFkku izfr vLirky fpfdRlk foHkkx LoLF; lsok;sa vLiRkkj jktLFkku ljdkj"
    garble_result = {
        "lines": [
            {"text": "LFkku izfr vLirky fpfdRlk foHkkx", "confidence": 0.92},
            {"text": "LoLF; lsok;sa vLiRkkj jktLFkku ljdkj", "confidence": 0.91},
        ],
        "full_text": garble_text,
        "mean_confidence": 0.915,
        "min_confidence": 0.91,
        "line_count": 2,
        "char_count": len(garble_text),
    }

    result = gate.evaluate(garble_result)
    assert result.passed is False
    assert result.details["valid_token_ratio"] < 0.35
    assert "LOW_VALID_TOKEN_RATIO" in result.reason


def test_quality_gate_classifies_borderline_confidence_pages():
    """Assert correct classification of borderline confidence pages in [0.70, 0.85]."""
    gate = QualityGate(
        min_mean_confidence=0.82,
        borderline_min_conf=0.70,
        borderline_max_conf=0.85,
    )

    # Sub-case A: Borderline confidence (0.83) with low validity (< 50%) -> Rejection
    mixed_garble_lines = [
        {"text": "Patient Name: xyzqwkjh zxcvbnm", "confidence": 0.83},
        {"text": "Clinic Report: asdflkjsdf", "confidence": 0.83},
        {"text": "qwerpoiuyt mnbvcxzlkjhg", "confidence": 0.83},
    ]
    mixed_garble_text = "\n".join(l["text"] for l in mixed_garble_lines)
    result_borderline_low = gate.evaluate({
        "lines": mixed_garble_lines,
        "full_text": mixed_garble_text,
        "mean_confidence": 0.83,
        "min_confidence": 0.83,
        "line_count": 3,
        "char_count": len(mixed_garble_text),
    })

    assert result_borderline_low.passed is False
    assert result_borderline_low.details["is_borderline"] is True
    assert "BORDERLINE_LOW_VALIDITY" in result_borderline_low.reason

    # Sub-case B: Borderline confidence (0.83) with high validity (>= 50%) -> Acceptance
    valid_clinic_lines = [
        {"text": "Patient Name: Jane Doe", "confidence": 0.83},
        {"text": "Diagnosis: Hypertension", "confidence": 0.83},
        {"text": "Rx: Amlodipine 5mg daily", "confidence": 0.83},
        {"text": "Hospital Consultation Note", "confidence": 0.83},
    ]
    valid_clinic_text = "\n".join(l["text"] for l in valid_clinic_lines)
    result_borderline_valid = gate.evaluate({
        "lines": valid_clinic_lines,
        "full_text": valid_clinic_text,
        "mean_confidence": 0.83,
        "min_confidence": 0.83,
        "line_count": 4,
        "char_count": len(valid_clinic_text),
    })

    assert result_borderline_valid.passed is True
    assert result_borderline_valid.details["is_borderline"] is True
    assert result_borderline_valid.reason == "Quality gate passed"

    # Sub-case C: High confidence (> 0.85) -> is_borderline is False
    result_high_conf = gate.evaluate({
        "lines": valid_clinic_lines,
        "full_text": valid_clinic_text,
        "mean_confidence": 0.95,
        "min_confidence": 0.95,
        "line_count": 4,
        "char_count": len(valid_clinic_text),
    })
    assert result_high_conf.passed is True
    assert result_high_conf.details["is_borderline"] is False
