from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock

from app.services.pipeline.summary_stage import (
    SummaryStageHandler,
    extract_key_bullet_points,
    strip_think_tokens,
)


def test_strip_think_tokens():
    raw_with_think = "<think>The user has diabetes and high cholesterol. Analyzing dosages...</think>Patient is prescribed Metformin 500mg and Atorvastatin 10mg."
    cleaned = strip_think_tokens(raw_with_think)
    assert "<think>" not in cleaned
    assert "</think>" not in cleaned
    assert "Analyzing dosages" not in cleaned
    assert "Metformin 500mg" in cleaned

    # Unclosed think tag
    unclosed = "Summary starts. <think>Model CoT reasoning trailing off"
    cleaned_unclosed = strip_think_tokens(unclosed)
    assert cleaned_unclosed == "Summary starts."


def test_extract_key_bullet_points():
    structured = {
        "diagnosis": ["Type 2 Diabetes Mellitus"],
        "medications": [{"name": "Metformin 500mg", "frequency": "1-0-1"}],
        "labResults": [
            {"testName": "HbA1c", "value": 8.5, "unit": "%", "flag": "HIGH", "referenceRange": "4.0 - 5.6 %"}
        ],
    }
    points = extract_key_bullet_points("Clinical text", structured, limit=5)
    assert len(points) == 3
    assert any("Type 2 Diabetes" in p for p in points)
    assert any("Metformin 500mg (1-0-1)" in p for p in points)
    assert any("HbA1c is 8.5" in p for p in points)


@pytest.mark.asyncio
async def test_dosage_preservation_across_summary():
    translation_mock = MagicMock()
    translation_mock.is_warm = True
    # Simulate translation preserving dosages
    translation_mock.translate = AsyncMock(
        return_value="દર્દીને Metformin 500mg અને Atorvastatin 10mg સૂચવવામાં આવે છે."
    )

    handler = SummaryStageHandler(summary_service=None, translation_service=translation_mock)

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

    assert result["dosagePreserved"] is True
    assert "500mg" in result["summaryEnglish"]
    assert "500" in result["summaryInPreferredLanguage"]
