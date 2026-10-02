from __future__ import annotations

import asyncio
import time
import unittest
from pathlib import Path
import fitz

from app.modules.file_processing.pdf_text import (
    extract_pdf_text_pages_from_bytes,
    try_extract_pdf_text_from_bytes,
    validate_page_direct_text,
)

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "pdf_text_cases"


class TestPdfFixtureGate(unittest.TestCase):
    """Integration test suite asserting text-layer sanitization against synthetic PDF fixtures."""

    @classmethod
    def setUpClass(cls) -> None:
        # Guarantee fixtures exist prior to running test assertions without mutating committed binaries
        required_fixtures = [
            "clean_born_digital.pdf",
            "cid_corrupted.pdf",
            "replacement_char_corrupted.pdf",
            "legacy_krutidev.pdf",
            "hybrid_mixed_pages.pdf",
        ]
        if not all((FIXTURES_DIR / name).exists() for name in required_fixtures):
            from scripts.generate_pdf_text_fixtures import generate_fixtures

            generate_fixtures(FIXTURES_DIR)

    def test_clean_born_digital_fixture(self) -> None:
        pdf_path = FIXTURES_DIR / "clean_born_digital.pdf"
        self.assertTrue(pdf_path.exists())
        pdf_bytes = pdf_path.read_bytes()

        # Warm-up pass to eliminate initial async event loop init overhead
        asyncio.run(try_extract_pdf_text_from_bytes(pdf_bytes))

        # Document-level direct extraction
        t0 = time.monotonic()
        extraction = asyncio.run(try_extract_pdf_text_from_bytes(pdf_bytes))
        elapsed_ms = (time.monotonic() - t0) * 1000

        self.assertIsNotNone(extraction, "Clean born-digital PDF should succeed direct extraction")
        assert extraction is not None  # type narrowing
        self.assertEqual(len(extraction.pages), 2)

        # Performance requirement: < 50ms per page
        avg_ms_per_page = elapsed_ms / len(extraction.pages)
        self.assertLess(avg_ms_per_page, 50.0, f"Extraction was too slow: {avg_ms_per_page:.2f} ms/page")

        # Page-level validation checks
        for page in extraction.pages:
            self.assertIsNotNone(page.validation)
            assert page.validation is not None
            self.assertTrue(page.validation.is_valid_direct_text)
            self.assertIsNone(page.validation.rejection_reason)

        # Full text content checks
        self.assertIn("HEMOGLOBIN", extraction.full_text)
        self.assertIn("BILIRUBIN TOTAL", extraction.full_text)

    def test_cid_corrupted_fixture(self) -> None:
        pdf_path = FIXTURES_DIR / "cid_corrupted.pdf"
        self.assertTrue(pdf_path.exists())
        pdf_bytes = pdf_path.read_bytes()

        # Document-level extraction MUST reject
        extraction = asyncio.run(try_extract_pdf_text_from_bytes(pdf_bytes))
        self.assertIsNone(extraction, "CID-corrupted PDF must be rejected by try_extract_pdf_text_from_bytes")

        # Page-level validation reveals specific rejection reason
        raw_extraction = asyncio.run(extract_pdf_text_pages_from_bytes(pdf_bytes))
        self.assertIsNotNone(raw_extraction)
        assert raw_extraction is not None
        p1 = raw_extraction.pages[0]
        self.assertIsNotNone(p1.validation)
        assert p1.validation is not None
        self.assertFalse(p1.validation.is_valid_direct_text)
        self.assertEqual(p1.validation.rejection_reason, "CID_CORRUPTION")
        self.assertGreater(p1.validation.metrics.get("cid_count", 0), 0)

    def test_replacement_char_corrupted_fixture(self) -> None:
        pdf_path = FIXTURES_DIR / "replacement_char_corrupted.pdf"
        self.assertTrue(pdf_path.exists())
        pdf_bytes = pdf_path.read_bytes()

        # Document-level extraction MUST reject
        extraction = asyncio.run(try_extract_pdf_text_from_bytes(pdf_bytes))
        self.assertIsNone(
            extraction,
            "Unicode replacement corrupted PDF must be rejected by try_extract_pdf_text_from_bytes",
        )

        # Page-level validation reveals specific rejection reason
        raw_extraction = asyncio.run(extract_pdf_text_pages_from_bytes(pdf_bytes))
        self.assertIsNotNone(raw_extraction)
        assert raw_extraction is not None
        p1 = raw_extraction.pages[0]
        self.assertIsNotNone(p1.validation)
        assert p1.validation is not None
        self.assertFalse(p1.validation.is_valid_direct_text)
        self.assertEqual(p1.validation.rejection_reason, "UNICODE_REPLACEMENT")

    def test_legacy_krutidev_fixture(self) -> None:
        pdf_path = FIXTURES_DIR / "legacy_krutidev.pdf"
        self.assertTrue(pdf_path.exists())
        pdf_bytes = pdf_path.read_bytes()

        # Document-level extraction MUST reject
        extraction = asyncio.run(try_extract_pdf_text_from_bytes(pdf_bytes))
        self.assertIsNone(extraction, "Legacy KrutiDev font PDF must be rejected by try_extract_pdf_text_from_bytes")

        # Page-level validation reveals legacy font or phonotactic garble
        raw_extraction = asyncio.run(extract_pdf_text_pages_from_bytes(pdf_bytes))
        self.assertIsNotNone(raw_extraction)
        assert raw_extraction is not None
        p1 = raw_extraction.pages[0]
        self.assertIsNotNone(p1.validation)
        assert p1.validation is not None
        self.assertFalse(p1.validation.is_valid_direct_text)
        self.assertIn(p1.validation.rejection_reason, {"LEGACY_INDIC_FONT", "PHONOTACTIC_GARBLE"})

    def test_hybrid_mixed_pages_fixture(self) -> None:
        pdf_path = FIXTURES_DIR / "hybrid_mixed_pages.pdf"
        self.assertTrue(pdf_path.exists())
        pdf_bytes = pdf_path.read_bytes()

        # Document-level extraction MUST reject because Page 2 is corrupted
        extraction = asyncio.run(try_extract_pdf_text_from_bytes(pdf_bytes))
        self.assertIsNone(extraction, "Hybrid mixed PDF must fail 100% direct extraction")

        # Per-page routing allows Page 1 direct text while flagging Page 2 for OCR
        raw_extraction = asyncio.run(extract_pdf_text_pages_from_bytes(pdf_bytes))
        self.assertIsNotNone(raw_extraction)
        assert raw_extraction is not None
        self.assertEqual(len(raw_extraction.pages), 2)

        p1 = raw_extraction.pages[0]
        p2 = raw_extraction.pages[1]

        # Page 1 is clean English born-digital
        self.assertIsNotNone(p1.validation)
        assert p1.validation is not None
        self.assertTrue(p1.validation.is_valid_direct_text)
        self.assertIsNone(p1.validation.rejection_reason)
        self.assertIn("HEMOGLOBIN", p1.text)

        # Page 2 is legacy KrutiDev font
        self.assertIsNotNone(p2.validation)
        assert p2.validation is not None
        self.assertFalse(p2.validation.is_valid_direct_text)
        self.assertIn(p2.validation.rejection_reason, {"LEGACY_INDIC_FONT", "PHONOTACTIC_GARBLE"})


if __name__ == "__main__":
    unittest.main()
