from __future__ import annotations

import fitz
import pytest
from pathlib import Path

from app.services.pipeline.ocr_stage import OcrStageHandler
from app.services.pipeline.lab_evaluator import LabEvaluator
from app.modules.ocr.cache import OCR_CACHE_PIPELINE_VERSION


class TestLabGroupedPayload:
    """Commit 3D: Grouped payload by report section and analyte."""

    def test_pipeline_version_bumped(self):
        assert OCR_CACHE_PIPELINE_VERSION == "v1.1"

    def test_fixture_sections_and_differential_merge(self):
        fixture_pdf = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "real_6page_digital.pdf"
        doc = fitz.open(fixture_pdf)
        extracted = OcrStageHandler.extract_spatial_parameters(doc)
        evaluated = LabEvaluator.evaluate_all(extracted)

        sections = LabEvaluator.group_by_sections(evaluated)
        assert len(sections) == 7

        section_names = [s["sectionName"] for s in sections]
        expected_sections = [
            "Complete Blood Count",
            "Differential",
            "Bleeding/Clotting Time",
            "Biochemistry",
            "HbA1c",
            "Coagulation",
            "Thyroid",
        ]
        assert section_names == expected_sections

        # Verify Differential section merged % and absolute
        diff_sec = next(s for s in sections if s["sectionName"] == "Differential")
        diff_names = [item["name"] for item in diff_sec["items"]]
        assert len(diff_sec["items"]) == 5
        assert "Lymphocyte" in diff_names or "Lymphocytes" in diff_names

        lymph_item = next(item for item in diff_sec["items"] if "Lymph" in item["name"])
        assert "percent" in lymph_item and "absolute" in lymph_item
        assert lymph_item["percent"]["value"] == 41.0
        assert lymph_item["percent"]["unit"] == "%"
        assert lymph_item["percent"]["status"] == "high"
        assert lymph_item["percent"]["severity"] == "borderline"
        assert lymph_item["absolute"]["value"] == 2993.0
        assert lymph_item["absolute"]["status"] == "normal"

        # Verify counts structure in all sections
        for s in sections:
            counts = s["counts"]
            assert set(counts.keys()) == {"abnormal", "borderline", "normal", "no_range", "info"}
            for v in counts.values():
                assert isinstance(v, int)
                assert v >= 0

        # Verify CBC counts
        cbc_sec = next(s for s in sections if s["sectionName"] == "Complete Blood Count")
        assert cbc_sec["counts"]["abnormal"] >= 1  # Hemoglobin
        assert cbc_sec["counts"]["borderline"] >= 1  # RBC / Hematocrit / RDW-CV
        assert cbc_sec["counts"]["normal"] >= 4  # Platelets, MCV, MCH, etc.

        # Verify HbA1c counts
        hba1c_sec = next(s for s in sections if s["sectionName"] == "HbA1c")
        assert hba1c_sec["counts"]["abnormal"] == 1  # HbA1c
        assert hba1c_sec["counts"]["info"] == 1  # Mean Plasma Glucose
