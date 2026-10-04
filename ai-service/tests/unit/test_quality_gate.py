from __future__ import annotations

import pytest
from app.modules.ocr.quality_gate import QualityGate, QualityGateResult


def test_quality_gate_passes_high_quality_ocr():
    gate = QualityGate()
    good_result = {
        "lines": [
            {"text": "Patient Name: Jane Doe", "confidence": 0.98},
            {"text": "Diagnosis: Hypertension", "confidence": 0.95},
            {"text": "Rx: Amlodipine 5mg once daily", "confidence": 0.96},
            {"text": "BP: 130/85 mmHg, Pulse: 72 bpm", "confidence": 0.94},
        ],
        "full_text": "Patient Name: Jane Doe\nDiagnosis: Hypertension\nRx: Amlodipine 5mg once daily\nBP: 130/85 mmHg, Pulse: 72 bpm",
        "mean_confidence": 0.9575,
        "min_confidence": 0.94,
        "line_count": 4,
        "char_count": 105,
    }

    result = gate.evaluate(good_result)
    assert result.passed is True
    assert result.reason == "Quality gate passed"
    assert result.mean_confidence == 0.9575
    assert result.low_confidence_line_ratio == 0.0


def test_quality_gate_rejects_low_mean_confidence():
    gate = QualityGate(min_mean_confidence=0.82)
    blurry_result = {
        "lines": [
            {"text": "Hospital Prescription Note", "confidence": 0.75},
            {"text": "Patient: Rahul Verma", "confidence": 0.70},
            {"text": "Medication: Paracetamol 500mg", "confidence": 0.68},
        ],
        "full_text": "Hospital Prescription Note\nPatient: Rahul Verma\nMedication: Paracetamol 500mg",
        "mean_confidence": 0.71,
        "min_confidence": 0.68,
        "line_count": 3,
        "char_count": 76,
    }

    result = gate.evaluate(blurry_result)
    assert result.passed is False
    assert "Mean confidence" in result.reason
    assert "below threshold" in result.reason


def test_quality_gate_rejects_insufficient_character_count():
    gate = QualityGate(min_char_count=30)
    sparse_result = {
        "lines": [{"text": "Page 1", "confidence": 0.99}],
        "full_text": "Page 1",
        "mean_confidence": 0.99,
        "min_confidence": 0.99,
        "line_count": 1,
        "char_count": 6,
    }

    result = gate.evaluate(sparse_result)
    assert result.passed is False
    assert "Character count (6) is below minimum threshold" in result.reason


def test_quality_gate_rejects_zero_character_count():
    gate = QualityGate()
    empty_result = {
        "lines": [],
        "full_text": "",
        "mean_confidence": 0.0,
        "min_confidence": 0.0,
        "line_count": 0,
        "char_count": 0,
    }

    result = gate.evaluate(empty_result)
    assert result.passed is False
    assert "Zero characters extracted" in result.reason


def test_quality_gate_rejects_high_ratio_of_low_confidence_lines():
    gate = QualityGate(line_confidence_floor=0.60, max_low_confidence_line_ratio=0.20)
    # 2 out of 5 lines (40%) below 0.60, even if mean is pulled up by other lines
    mixed_result = {
        "lines": [
            {"text": "Medical Summary Header", "confidence": 0.99},
            {"text": "Unreadable scribble one", "confidence": 0.45},
            {"text": "Unreadable scribble two", "confidence": 0.40},
            {"text": "Doctor Signature Block", "confidence": 0.95},
            {"text": "Date of Consultation", "confidence": 0.95},
        ],
        "full_text": "Medical Summary Header\nUnreadable scribble one\nUnreadable scribble two\nDoctor Signature Block\nDate of Consultation",
        "mean_confidence": 0.85,  # Above 0.82
        "min_confidence": 0.40,
        "line_count": 5,
        "char_count": 105,
    }

    result = gate.evaluate(mixed_result)
    assert result.passed is False
    assert "Low confidence line ratio" in result.reason
    assert "exceeds maximum allowed" in result.reason


def test_quality_gate_rejects_excessive_symbol_noise():
    gate = QualityGate(min_alphanumeric_ratio=0.40)
    noisy_result = {
        "lines": [
            {"text": "|||||| ~~~~~ ^^^^^ +++++ ;;;;", "confidence": 0.90},
            {"text": "---- ===== **** %%%% #### @@@", "confidence": 0.90},
        ],
        "full_text": "|||||| ~~~~~ ^^^^^ +++++ ;;;;\n---- ===== **** %%%% #### @@@",
        "mean_confidence": 0.90,
        "min_confidence": 0.90,
        "line_count": 2,
        "char_count": 58,
    }

    result = gate.evaluate(noisy_result)
    assert result.passed is False
    assert "Alphanumeric ratio" in result.reason
    assert "below minimum allowed" in result.reason


def test_quality_gate_handles_empty_or_none_input():
    gate = QualityGate()
    assert gate.evaluate({}).passed is False
    assert gate.evaluate(None).passed is False
