from __future__ import annotations

import re
from pathlib import Path
import fitz
import pytest

from app.modules.file_processing.pdf_text import (
    validate_page_direct_text,
    remove_watermark_and_id_tokens,
)

FIXTURE_PDF_PATH = (
    Path(__file__).resolve().parent.parent
    / "fixtures"
    / "golden_docs"
    / "real_6page_digital.pdf"
)


def test_remove_watermark_and_id_tokens():
    raw_text = (
        "BLOOD COUNT\n"
        "a3ec807f-1a85-4d6e-883a-c7b6a7762a7a[5069200904-Patient Name-70 Years-Female]\n"
        "Hemoglobin (Photometric) 11.20 gm%\n"
        "b642449c-d20e-4782-8f5a-d8884ac3228d[5069200904-Patient]\n"
    )
    cleaned = remove_watermark_and_id_tokens(raw_text)
    assert "a3ec807f" not in cleaned
    assert "b642449c" not in cleaned
    assert "Years-Female" not in cleaned
    assert "BLOOD COUNT" in cleaned
    assert "Hemoglobin (Photometric) 11.20 gm%" in cleaned


def test_remove_watermark_repeated_tokens():
    # Token repeated 25 times
    repeated_token = "WATERMARKTOKEN99"
    lines = ["Test Line 1", "Test Line 2"] + [repeated_token] * 25 + ["Hemoglobin 14.0 g/dL"]
    raw = "\n".join(lines)
    cleaned = remove_watermark_and_id_tokens(raw)
    assert repeated_token not in cleaned
    assert "Hemoglobin 14.0 g/dL" in cleaned


def test_fixture_real_6page_digital_all_pages_pass_direct_text():
    assert FIXTURE_PDF_PATH.exists(), f"Missing fixture at {FIXTURE_PDF_PATH}"
    doc = fitz.open(FIXTURE_PDF_PATH)
    assert len(doc) == 6, f"Expected 6 pages, got {len(doc)}"

    all_page_texts = [p.get_text("text") for p in doc]

    for idx, page in enumerate(doc):
        page_num = idx + 1
        raw_text = all_page_texts[idx]
        val_res = validate_page_direct_text(
            doc,
            page_number=page_num,
            text=raw_text,
            doc_page_texts=all_page_texts,
        )
        assert (
            val_res.is_valid_direct_text is True
        ), f"Page {page_num} failed validation: {val_res.rejection_reason}, metrics={val_res.metrics}"
        assert val_res.rejection_reason is None
        # Assert watermarks are absent from the validated text
        assert not re.search(
            r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
            val_res.text,
        ), f"Page {page_num} still contains UUID watermarks in validated text"


def test_negative_genuine_garbled_text_still_rejected():
    garbled_text = (
        "zkqpx vwmnt flgbrd xztpq kjhmfc bdfghjklmn rstvwx bcdfghj "
        "qwrtyp sdfghj klzxcv bnmqwr typasdf ghjklz xcvbnm"
    )
    val_res = validate_page_direct_text(None, page_number=1, text=garbled_text)
    assert val_res.is_valid_direct_text is False
    assert val_res.rejection_reason == "PHONOTACTIC_GARBLE"
