from __future__ import annotations

import pytest
from unittest.mock import AsyncMock, MagicMock, patch

from app.services.translation_service import (
    mask_text,
    unmask_text,
    validate_placeholder_integrity,
    split_sentences_clean,
)


def test_python_mask_text_uses_white_square_brackets():
    text = "Patient HbA1c is 8.5% on 15-Jan-2026. Normal range is 4.0 - 5.6%. Prescribed Metformin 500mg."
    masked, masks = mask_text(text)

    # Placeholders should be ⟦1⟧, ⟦2⟧...
    assert "⟦1⟧" in masked
    assert "⟦2⟧" in masked
    assert len(masks) >= 4

    # Unmasking restores the original text
    restored = unmask_text(masked, masks)
    assert "HbA1c" in restored
    assert "8.5%" in restored
    assert "Metformin" in restored
    assert "500mg" in restored
    assert "⟦" not in restored


def test_python_validate_placeholder_integrity():
    masks = ["HbA1c", "8.5%"]

    # Valid translation preserving every placeholder exactly once
    valid_output = "દર્દીનું ⟦1⟧ સ્તર ⟦2⟧ છે."
    assert validate_placeholder_integrity(valid_output, len(masks)) is True

    # Missing placeholder
    missing_output = "દર્દીનું સ્તર ⟦2⟧ છે."
    assert validate_placeholder_integrity(missing_output, len(masks)) is False

    # Duplicated placeholder
    duplicated_output = "દર્દીનું ⟦1⟧ અને ⟦1⟧ સ્તર ⟦2⟧ છે."
    assert validate_placeholder_integrity(duplicated_output, len(masks)) is False

    # Extra hallucinated placeholder
    extra_output = "દર્દીનું ⟦1⟧ સ્તર ⟦2⟧ અને ⟦3⟧ છે."
    assert validate_placeholder_integrity(extra_output, len(masks)) is False


def test_python_split_sentences_clean():
    text = "HbA1c is 8.5%. Fasting glucose is 110 mg/dL. Prescribed Metformin 500mg!"
    sentences = split_sentences_clean(text)
    assert len(sentences) == 3
    assert sentences[0] == "HbA1c is 8.5%."
    assert sentences[1] == "Fasting glucose is 110 mg/dL."
    assert sentences[2] == "Prescribed Metformin 500mg!"
