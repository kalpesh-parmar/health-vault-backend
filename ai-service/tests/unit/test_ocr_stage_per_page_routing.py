from __future__ import annotations

import asyncio
import unittest
from pathlib import Path
from unittest.mock import MagicMock
from uuid import uuid4

from app.services.pipeline.ocr_stage import OcrStageHandler

FIXTURES_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "pdf_text_cases"


class MockPaddleEngine:
    def __init__(self, text: str = "EXTRACTED RASTER OCR TEXT"):
        self.text = text
        self.config_hash = "mock_paddle_hash"
        self.lang = "en"

    def is_available(self) -> bool:
        return True

    async def async_extract_text_from_bytes(self, img_bytes: bytes) -> dict:
        return {
            "full_text": self.text,
            "mean_confidence": 0.95,
            "line_count": 1,
            "lines": [{"text": self.text, "confidence": 0.95}],
            "timings": {},
            "worker_pid": 12345,
        }


class TestOcrStagePerPageRouting(unittest.TestCase):
    """Integration test suite verifying per-page hybrid routing and telemetry in ocr_stage.py."""

    @classmethod
    def setUpClass(cls) -> None:
        from scripts.generate_pdf_text_fixtures import generate_fixtures

        generate_fixtures(FIXTURES_DIR)

    def setUp(self) -> None:
        self.s3_mock = MagicMock()
        self.paddle_mock = MockPaddleEngine(text="EXTRACTED RASTER OCR CLINICAL REPORT")
        self.handler = OcrStageHandler(
            s3_client=self.s3_mock,
            lifecycle=None,
            vision_service=None,
            paddle_engine=self.paddle_mock,
            min_direct_text_chars=8,
        )

    def test_clean_born_digital_routes_all_pages_direct(self) -> None:
        pdf_path = FIXTURES_DIR / "clean_born_digital.pdf"
        self.assertTrue(pdf_path.exists())

        res = asyncio.run(
            self.handler.run_ocr(
                file_path=pdf_path,
                filename="clean_born_digital.pdf",
                job_id=uuid4(),
                file_key="test/clean_born_digital.pdf",
                current_pct=20,
                completed_stages=[],
                checkpoint_data={},
                mime_type="application/pdf",
            )
        )

        metrics = res["metrics"]
        self.assertEqual(metrics["direct_text_page_count"], 2)
        self.assertEqual(metrics["raster_ocr_page_count"], 0)
        self.assertFalse(metrics["hybrid_extraction"])
        self.assertTrue(metrics["used_direct_text"])
        self.assertFalse(metrics["used_ocr"])

        self.assertEqual(len(res["pages"]), 2)
        for page in res["pages"]:
            self.assertEqual(page["engine"], "pymupdf_direct")
            self.assertEqual(page["status"], "SUCCESS")

        self.assertIn("HEMOGLOBIN", res["fullText"])
        self.assertIn("BILIRUBIN TOTAL", res["fullText"])

    def test_corrupted_cid_routes_to_raster_ocr(self) -> None:
        pdf_path = FIXTURES_DIR / "cid_corrupted.pdf"
        self.assertTrue(pdf_path.exists())

        res = asyncio.run(
            self.handler.run_ocr(
                file_path=pdf_path,
                filename="cid_corrupted.pdf",
                job_id=uuid4(),
                file_key="test/cid_corrupted.pdf",
                current_pct=20,
                completed_stages=[],
                checkpoint_data={},
                mime_type="application/pdf",
            )
        )

        metrics = res["metrics"]
        self.assertEqual(metrics["direct_text_page_count"], 0)
        self.assertEqual(metrics["raster_ocr_page_count"], 1)
        self.assertFalse(metrics["hybrid_extraction"])

        decisions = metrics["per_page_routing_decisions"]
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["page"], 1)
        self.assertEqual(decisions[0]["decision"], "raster_ocr")
        self.assertEqual(decisions[0]["reason"], "CID_CORRUPTION")

        # Confirm CID patterns do not leak into final extracted text
        self.assertNotIn("(cid:", res["fullText"])
        self.assertEqual(res["pages"][0]["engine"], "paddleocr")

    def test_legacy_krutidev_routes_to_raster_ocr(self) -> None:
        pdf_path = FIXTURES_DIR / "legacy_krutidev.pdf"
        self.assertTrue(pdf_path.exists())

        res = asyncio.run(
            self.handler.run_ocr(
                file_path=pdf_path,
                filename="legacy_krutidev.pdf",
                job_id=uuid4(),
                file_key="test/legacy_krutidev.pdf",
                current_pct=20,
                completed_stages=[],
                checkpoint_data={},
                mime_type="application/pdf",
            )
        )

        metrics = res["metrics"]
        self.assertEqual(metrics["direct_text_page_count"], 0)
        self.assertEqual(metrics["raster_ocr_page_count"], 1)
        self.assertFalse(metrics["hybrid_extraction"])

        decisions = metrics["per_page_routing_decisions"]
        self.assertEqual(len(decisions), 1)
        self.assertEqual(decisions[0]["decision"], "raster_ocr")
        self.assertIn(decisions[0]["reason"], {"LEGACY_INDIC_FONT", "PHONOTACTIC_GARBLE"})

        # Confirm pseudo-Latin gibberish is not accepted as direct text
        self.assertNotIn("LFkku izfr vLirky", res["fullText"])
        self.assertEqual(res["pages"][0]["engine"], "paddleocr")

    def test_hybrid_mixed_pdf_routes_clean_to_direct_and_corrupt_to_raster(self) -> None:
        pdf_path = FIXTURES_DIR / "hybrid_mixed_pages.pdf"
        self.assertTrue(pdf_path.exists())

        res = asyncio.run(
            self.handler.run_ocr(
                file_path=pdf_path,
                filename="hybrid_mixed_pages.pdf",
                job_id=uuid4(),
                file_key="test/hybrid_mixed_pages.pdf",
                current_pct=20,
                completed_stages=[],
                checkpoint_data={},
                mime_type="application/pdf",
            )
        )

        metrics = res["metrics"]
        self.assertEqual(metrics["direct_text_page_count"], 1)
        self.assertEqual(metrics["raster_ocr_page_count"], 1)
        self.assertTrue(metrics["hybrid_extraction"])

        pages = res["pages"]
        self.assertEqual(len(pages), 2)
        # Assert strict sequential reassembly [1, 2]
        self.assertEqual(pages[0]["page"], 1)
        self.assertEqual(pages[1]["page"], 2)

        # Page 1: Clean born-digital English lab report
        self.assertEqual(pages[0]["engine"], "pymupdf_direct")
        self.assertIn("HEMOGLOBIN", pages[0]["text"])

        # Page 2: Corrupted legacy Indic prescription -> raster OCR
        self.assertEqual(pages[1]["engine"], "paddleocr")
        self.assertEqual(pages[1]["text"], "EXTRACTED RASTER OCR CLINICAL REPORT")

        decisions = metrics["per_page_routing_decisions"]
        self.assertEqual(len(decisions), 2)
        self.assertEqual(decisions[0]["decision"], "pymupdf_direct")
        self.assertEqual(decisions[1]["decision"], "raster_ocr")


if __name__ == "__main__":
    unittest.main()
