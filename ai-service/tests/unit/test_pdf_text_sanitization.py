from __future__ import annotations

import unittest
from unittest.mock import MagicMock
import fitz

from app.modules.file_processing.pdf_text import (
    PageTextValidationResult,
    decode_symbol_pua_text,
    detect_cid_artifacts,
    detect_legacy_indic_fonts,
    detect_phonotactic_garble,
    detect_replacement_chars,
    validate_page_direct_text,
    MEDICAL_WHITELIST,
)


class TestPdfTextSanitization(unittest.TestCase):
    """Unit tests for text-layer sanitization and garble detection in pdf_text.py."""

    def test_detect_cid_artifacts_flags_cid_stream(self) -> None:
        cid_corrupted = (
            "PATIENT REPORT (cid:12)(cid:34) (cid:56) BLOOD SUGAR (cid:78)(cid:90) NORMAL"
        )
        flagged, ratio, count = detect_cid_artifacts(cid_corrupted)
        self.assertTrue(flagged)
        self.assertGreater(count, 0)
        self.assertGreater(ratio, 0.05)

        clean_text = "COMPLETE BLOOD COUNT REPORT FOR PATIENT JOHN DOE HEMOGLOBIN 14.2 g/dL"
        clean_flagged, clean_ratio, clean_count = detect_cid_artifacts(clean_text)
        self.assertFalse(clean_flagged)
        self.assertEqual(clean_count, 0)
        self.assertEqual(clean_ratio, 0.0)

    def test_detect_replacement_chars_flags_corrupted_unicode(self) -> None:
        replacement_corrupted = "LAB RESULTS \ufffd\ufffd\ufffd\ufffd SERUM CREATININE \ufffd\ufffd"
        flagged, ratio, count = detect_replacement_chars(replacement_corrupted)
        self.assertTrue(flagged)
        self.assertGreaterEqual(count, 3)
        self.assertGreater(ratio, 0.02)

        clean_text = "LIVER FUNCTION TEST SGOT 32 U/L SGPT 28 U/L BILIRUBIN 0.8 mg/dL"
        clean_flagged, clean_ratio, clean_count = detect_replacement_chars(clean_text)
        self.assertFalse(clean_flagged)
        self.assertEqual(clean_count, 0)
        self.assertEqual(clean_ratio, 0.0)

    def test_detect_legacy_indic_fonts_identifies_families(self) -> None:
        # 1. Test mock doc with KrutiDev and Shree-Lipi fonts
        mock_doc = MagicMock()
        mock_page = MagicMock()
        # font tuple format: (xref, ext, type, basefont, name, encoding, ...)
        mock_page.get_fonts.return_value = [
            (5, "ttf", "TrueType", "KrutiDev010", "F1", "WinAnsiEncoding"),
            (6, "ttf", "TrueType", "Arial-BoldMT", "F2", "WinAnsiEncoding"),
        ]
        mock_doc.page_count = 1
        mock_doc.load_page.return_value = mock_page

        flagged, matched = detect_legacy_indic_fonts(mock_doc, 1)
        self.assertTrue(flagged)
        self.assertIn("KrutiDev010", matched)

        # 2. Test mock doc with clean modern fonts
        mock_clean_doc = MagicMock()
        mock_clean_page = MagicMock()
        mock_clean_page.get_fonts.return_value = [
            (1, "ttf", "TrueType", "Helvetica", "F1", "WinAnsiEncoding"),
            (2, "ttf", "TrueType", "Times-Roman", "F2", "WinAnsiEncoding"),
        ]
        mock_clean_doc.page_count = 1
        mock_clean_doc.load_page.return_value = mock_clean_page

        clean_flagged, clean_matched = detect_legacy_indic_fonts(mock_clean_doc, 1)
        self.assertFalse(clean_flagged)
        self.assertEqual(clean_matched, [])

        # 3. Test None or invalid doc gracefully
        none_flagged, none_matched = detect_legacy_indic_fonts(None, 1)
        self.assertFalse(none_flagged)
        self.assertEqual(none_matched, [])

    def test_detect_phonotactic_garble_catches_pseudo_latin(self) -> None:
        # Legacy Indic fonts (e.g. KrutiDev) mapping Devanagari to Latin characters
        krutidev_pseudo_latin = (
            "LFkku izfr vLirky dzekad izi= vkns'k jksxh fooj.k fnukad MkWDVj"
        )
        flagged, metric, anomalous = detect_phonotactic_garble(krutidev_pseudo_latin)
        self.assertTrue(flagged)
        self.assertGreaterEqual(len(anomalous), 1)

    def test_medical_whitelist_protects_dense_lab_panels(self) -> None:
        dense_lab_text = (
            "PATIENT LAB REPORT "
            "WBC 11000 cells/cumm "
            "RBC 4.5 mill/cumm "
            "SGOT 35 U/L "
            "SGPT 40 U/L "
            "HbA1c 6.5 % "
            "AST 32 U/L "
            "ALT 38 U/L "
            "TSH 2.5 mu/L "
            "SERUM CREATININE 0.9 mg/dL "
            "BP 120/80 mmHg "
            "PR 72 bpm "
            "MCV 88 fl "
            "MCH 29 pg"
        )
        flagged, metric, anomalous = detect_phonotactic_garble(dense_lab_text)
        self.assertFalse(
            flagged,
            f"Dense lab panel was incorrectly flagged as phonotactic garble! Anomalous tokens: {anomalous}",
        )
        self.assertEqual(anomalous, [])

        # Verify key clinical terms exist in MEDICAL_WHITELIST
        for term in ["wbc", "rbc", "sgot", "sgpt", "hba1c", "ast", "alt", "mg/dl", "mmhg", "bpm"]:
            self.assertIn(term, MEDICAL_WHITELIST)

    def test_symbol_pua_decoding_preserved(self) -> None:
        # \uf052\uf065\uf070\uf06f\uf072\uf074 -> Report
        pua_text = "\uf052\uf065\uf070\uf06f\uf072\uf074 \uf04c\uf061\uf062"
        decoded = decode_symbol_pua_text(pua_text)
        self.assertEqual(decoded, "Report Lab")

        # In a full page validation, this should be valid direct text once decoded
        val_res = validate_page_direct_text(None, 1, pua_text + " FOR CLINICAL INVESTIGATION RESULTS NORMAL")
        self.assertTrue(val_res.is_valid_direct_text)
        self.assertIsNone(val_res.rejection_reason)
        self.assertIn("Report Lab", val_res.text)

    def test_validate_page_direct_text_priority_and_reasons(self) -> None:
        # 1. Insufficient text
        res_short = validate_page_direct_text(None, 1, "Short")
        self.assertFalse(res_short.is_valid_direct_text)
        self.assertEqual(res_short.rejection_reason, "INSUFFICIENT_TEXT")

        # 2. CID corruption
        cid_text = "PATIENT REPORT " + " ".join(f"(cid:{i})" for i in range(10))
        res_cid = validate_page_direct_text(None, 1, cid_text)
        self.assertFalse(res_cid.is_valid_direct_text)
        self.assertEqual(res_cid.rejection_reason, "CID_CORRUPTION")

        # 3. Unicode replacement
        repl_text = "PATIENT REPORT WITH UNICODE REPLACEMENTS " + "\ufffd" * 15
        res_repl = validate_page_direct_text(None, 1, repl_text)
        self.assertFalse(res_repl.is_valid_direct_text)
        self.assertEqual(res_repl.rejection_reason, "UNICODE_REPLACEMENT")

        # 4. Phonotactic garble
        garble_text = "LFkku izfr vLirky dzekad izi= vkns'k jksxh fooj.k fnukad"
        res_garble = validate_page_direct_text(None, 1, garble_text)
        self.assertFalse(res_garble.is_valid_direct_text)
        self.assertEqual(res_garble.rejection_reason, "PHONOTACTIC_GARBLE")

        # 5. Clean text passes
        clean_text = "PATIENT JOHN DOE COMPLETE BLOOD COUNT REPORT NORMAL WBC 7500 CELLS/CUMM"
        res_clean = validate_page_direct_text(None, 1, clean_text)
        self.assertTrue(res_clean.is_valid_direct_text)
        self.assertIsNone(res_clean.rejection_reason)


if __name__ == "__main__":
    unittest.main()
