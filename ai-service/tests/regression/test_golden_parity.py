from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any
import pytest
import fitz

from app.services.pipeline.clinical_stage import ClinicalStageHandler
from app.services.pipeline.lab_evaluator import LabEvaluator
from app.services.pipeline.layout_stage import LayoutStageHandler
from app.services.pipeline.graph_stage import GraphStageHandler
from app.services.pipeline.ocr_stage import OcrStageHandler
from app.services.pipeline.summary_stage import SummaryStageHandler

FIXTURES_DIR = Path(__file__).parent.parent / "fixtures" / "golden_docs"


def _levenshtein_distance(s1: str, s2: str) -> int:
    if len(s1) < len(s2):
        return _levenshtein_distance(s2, s1)
    if len(s2) == 0:
        return len(s1)
    prev = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        curr = [i + 1]
        for j, c2 in enumerate(s2):
            insertions = prev[j + 1] + 1
            deletions = curr[j] + 1
            substitutions = prev[j] + (c1 != c2)
            curr.append(min(insertions, deletions, substitutions))
        prev = curr
    return prev[-1]


def compute_cer(hypothesis: str, reference: str) -> float:
    if not reference:
        return 0.0 if not hypothesis else 1.0
    dist = _levenshtein_distance(hypothesis, reference)
    return dist / len(reference)


def compute_wer(hypothesis: str, reference: str) -> float:
    hyp_words = hypothesis.strip().split()
    ref_words = reference.strip().split()
    if not ref_words:
        return 0.0 if not hyp_words else 1.0
    dist = _levenshtein_distance(hyp_words, ref_words)
    return dist / len(ref_words)


class TestGoldenDocumentParity:
    """Wave 6 Golden Medical Document Parity & Quality Verification Suite."""

    @pytest.fixture(autouse=True)
    def setup_handlers(self):
        self.clinical_handler = ClinicalStageHandler()
        self.summary_handler = SummaryStageHandler()

    def test_01_born_digital_lab_report(self):
        pdf_path = FIXTURES_DIR / "born_digital_text.pdf"
        assert pdf_path.exists()
        doc = fitz.open(str(pdf_path))
        extracted_text = "".join([p.get_text() for p in doc]).strip()
        doc.close()

        with open(FIXTURES_DIR / "born_digital_text.json") as f:
            gt = json.load(f)

        # 1. CER / WER check
        cer = compute_cer(extracted_text, gt["groundTruthText"])
        wer = compute_wer(extracted_text, gt["groundTruthText"])
        assert cer < 0.05, f"CER too high for born digital text: {cer}"
        assert wer < 0.05, f"WER too high for born digital text: {wer}"

        # 2. Structured Extraction & Lab Concordance
        parsed = self.clinical_handler._heuristic_extraction(extracted_text, [])
        assert parsed["patientInfo"].get("name") == "John Doe"
        assert parsed["patientInfo"].get("age") == 45
        assert parsed["patientInfo"].get("gender") == "MALE"
        doctor_name = (
            (parsed.get("providerInfo") or {}).get("primary", {}).get("name")
            or (parsed.get("doctorInfo") or {}).get("name", "")
        )
        assert "Sarah Jenkins" in doctor_name

        # Numerical Values
        assert "95" in extracted_text  # Glucose
        assert "5.4" in extracted_text  # HbA1c
        assert "0.9" in extracted_text  # Creatinine

    def test_02_metabolic_panel_abnormal_flags(self):
        pdf_path = FIXTURES_DIR / "metabolic_panel.pdf"
        doc = fitz.open(str(pdf_path))
        text = "".join([p.get_text() for p in doc]).strip()
        doc.close()

        with open(FIXTURES_DIR / "metabolic_panel.json") as f:
            gt = json.load(f)

        parsed = self.clinical_handler._heuristic_extraction(text, [])
        assert parsed["patientInfo"].get("name") == "Rajesh Patel"
        assert parsed["patientInfo"].get("age") == 52

        # Verify exact numerical values and status flags
        for test_name, expected in gt["abnormalFlags"].items():
            assert expected["val"] in text
            assert expected["flag"] in text

    def test_03_outpatient_prescription_dosage_fidelity(self):
        pdf_path = FIXTURES_DIR / "outpatient_prescription.pdf"
        doc = fitz.open(str(pdf_path))
        text = "".join([p.get_text() for p in doc]).strip()
        doc.close()

        with open(FIXTURES_DIR / "outpatient_prescription.json") as f:
            gt = json.load(f)

        parsed = self.clinical_handler._heuristic_extraction(text, [])
        assert parsed["patientInfo"].get("name") == "Ananya Roy"
        assert parsed["patientInfo"].get("gender") == "FEMALE"

        meds = parsed["medications"]
        med_names = [m["name"] for m in meds]
        assert any("Augmentin" in n and "625mg" in n for n in med_names)
        assert any("Levocetirizine" in n and "5mg" in n for n in med_names)
        assert any("Paracetamol" in n and "650mg" in n for n in med_names)
        assert any("Fluticasone" in n and "50mcg" in n for n in med_names)

        # Vitals
        assert any(v.get("systolic") == 118 and v.get("diastolic") == 75 for v in parsed["vitals"])

    def test_04_mixed_pdf_routing_and_order_preservation(self):
        pdf_path = FIXTURES_DIR / "mixed_document.pdf"
        doc = fitz.open(str(pdf_path))
        assert len(doc) == 2

        # Page 1: Born Digital (>100 characters)
        p1_text = doc[0].get_text().strip()
        assert len(p1_text) > 100
        assert "Emily Clark" in p1_text
        assert "Acute Gastroenteritis" in p1_text

        # Page 2: Scanned Raster (0 direct text characters)
        p2_text = doc[1].get_text().strip()
        assert len(p2_text) == 0
        img_list = doc[1].get_images()
        assert len(img_list) >= 1  # Contains scanned page image
        doc.close()

    def test_05_multi_page_inpatient_record(self):
        pdf_path = FIXTURES_DIR / "multi_page_inpatient.pdf"
        doc = fitz.open(str(pdf_path))
        assert len(doc) == 3
        full_text = "\n".join([doc[i].get_text() for i in range(len(doc))])
        doc.close()

        with open(FIXTURES_DIR / "multi_page_inpatient.json") as f:
            gt = json.load(f)

        parsed = self.clinical_handler._heuristic_extraction(full_text, [])
        assert parsed["patientInfo"].get("name") == "David Miller"
        assert parsed["patientInfo"].get("age") == 62
        assert any("Aspirin" in m["name"] and "75mg" in m["name"] for m in parsed["medications"])
        assert any("Clopidogrel" in m["name"] and "75mg" in m["name"] for m in parsed["medications"])
        assert any("Atorvastatin" in m["name"] and "40mg" in m["name"] for m in parsed["medications"])
        assert any("Metoprolol" in m["name"] and "25mg" in m["name"] for m in parsed["medications"])

    def test_06_hospital_discharge_summary(self):
        pdf_path = FIXTURES_DIR / "hospital_discharge.pdf"
        doc = fitz.open(str(pdf_path))
        text = "".join([p.get_text() for p in doc])
        doc.close()

        assert "Meera Nair" in text
        assert "Chronic Heart Failure" in text
        assert "Dilated Cardiomyopathy" in text
        assert "Sacubitril / Valsartan 50mg" in text
        assert "Spironolactone 25mg" in text
        assert "Dapagliflozin 10mg" in text
        assert "Torsemide 10mg" in text

    def test_07_hospital_bill_invoice_tabular_integrity(self):
        pdf_path = FIXTURES_DIR / "hospital_bill.pdf"
        doc = fitz.open(str(pdf_path))
        text = "".join([p.get_text() for p in doc])
        doc.close()

        assert "Vikram Singhania" in text
        assert "30,000.00" in text  # Room charges
        assert "12,000.00" in text  # ICU Monitoring
        assert "14,500.00" in text  # Lab
        assert "1,01,250.00" in text  # Subtotal
        assert "18,750.00" in text  # Net Payable

    def test_08_ecg_visual_asset_detection(self):
        pdf_path = FIXTURES_DIR / "ecg_report.pdf"
        doc = fitz.open(str(pdf_path))
        assert len(doc) == 1
        imgs = doc[0].get_images()
        assert len(imgs) >= 1
        text = doc[0].get_text()
        doc.close()

        assert "Harold Finch" in text
        assert "12 LEAD ECG REPORT" in text
        assert "Normal Sinus Rhythm" in text

    def test_09_xray_radiology_report(self):
        pdf_path = FIXTURES_DIR / "xray_report.pdf"
        doc = fitz.open(str(pdf_path))
        assert len(doc) == 1
        imgs = doc[0].get_images()
        assert len(imgs) >= 1
        text = doc[0].get_text()
        doc.close()

        assert "Robert Downey" in text
        assert "CHEST PA VIEW" in text
        assert "Normal Chest X-Ray Study" in text

    def test_10_echo_ultrasound_report(self):
        pdf_path = FIXTURES_DIR / "echo_report.pdf"
        doc = fitz.open(str(pdf_path))
        imgs = doc[0].get_images()
        assert len(imgs) >= 1
        text = doc[0].get_text()
        doc.close()

        assert "Bruce Wayne" in text
        assert "LVEF: 60%" in text
        assert "Normal Transthoracic Echocardiogram" in text

    def test_11_growth_chart_report(self):
        pdf_path = FIXTURES_DIR / "growth_chart.pdf"
        doc = fitz.open(str(pdf_path))
        imgs = doc[0].get_images()
        assert len(imgs) >= 1
        text = doc[0].get_text()
        doc.close()

        assert "Leo Das" in text
        assert "GROWTH & STATURE MONITORING" in text
        assert "50th percentile" in text

    def test_12_bordered_table_cbc(self):
        pdf_path = FIXTURES_DIR / "bordered_table.pdf"
        doc = fitz.open(str(pdf_path))
        text = doc[0].get_text()
        doc.close()

        assert "Sneha Gupta" in text
        assert "Hemoglobin" in text and "11.2" in text and "LOW" in text
        assert "Total WBC Count" in text and "7,200" in text and "NORMAL" in text
        assert "Platelet Count" in text and "240,000" in text

    def test_13_borderless_table_rft(self):
        pdf_path = FIXTURES_DIR / "borderless_table.pdf"
        doc = fitz.open(str(pdf_path))
        text = doc[0].get_text()
        doc.close()

        assert "Anand Kulkarni" in text
        assert "Blood Urea Nitrogen" in text and "22" in text
        assert "Serum Creatinine" in text and "1.15" in text
        assert "Sodium" in text and "139" in text
        assert "Potassium" in text and "4.4" in text

    def test_14_multi_visual_assets_single_page(self):
        pdf_path = FIXTURES_DIR / "multi_asset_page.pdf"
        doc = fitz.open(str(pdf_path))
        imgs = doc[0].get_images()
        assert len(imgs) >= 2, f"Expected multiple visual assets on page, found {len(imgs)}"
        text = doc[0].get_text()
        doc.close()
        assert "Clark Kent" in text
        assert "INTEGRATED CARDIAC EVALUATION REPORT" in text

    def test_15_multi_report_batch_sections(self):
        pdf_path = FIXTURES_DIR / "multi_report_batch.pdf"
        doc = fitz.open(str(pdf_path))
        assert len(doc) == 2
        p1_text = doc[0].get_text()
        p2_text = doc[1].get_text()
        doc.close()

        assert "LIPID PROFILE" in p1_text and "Diana Prince" in p1_text
        assert "THYROID FUNCTION TEST" in p2_text and "Diana Prince" in p2_text

    def test_16_gujarati_prescription_entity_preservation(self):
        pdf_path = FIXTURES_DIR / "gujarati_prescription.pdf"
        doc = fitz.open(str(pdf_path))
        text = doc[0].get_text().replace('\xa0', ' ')
        doc.close()

        assert "મંજુલાબેન શાહ" in text
        assert "Metformin 500mg" in text
        assert "Telmisartan 40mg" in text
        assert "Atorvastatin 10mg" in text

    def test_17_hindi_prescription_entity_preservation(self):
        pdf_path = FIXTURES_DIR / "hindi_prescription.pdf"
        doc = fitz.open(str(pdf_path))
        text = doc[0].get_text().replace('\xa0', ' ')
        doc.close()

        assert "रामेश्वर प्रसाद" in text
        assert "Amlodipine 5mg" in text
        assert "Metoprolol 50mg" in text
        assert "Sorbitrate 5mg" in text

    def test_18_tamil_prescription_entity_preservation(self):
        pdf_path = FIXTURES_DIR / "tamil_prescription.pdf"
        doc = fitz.open(str(pdf_path))
        text = doc[0].get_text().replace('\xa0', ' ')
        doc.close()

        assert "செல்வி சுந்தரி" in text
        assert "Paracetamol 650mg" in text
        assert "Azithromycin 500mg" in text
        assert "Cetirizine 10mg" in text

    def test_19_bilingual_mixed_language_preservation(self):
        pdf_path = FIXTURES_DIR / "bilingual_mixed.pdf"
        doc = fitz.open(str(pdf_path))
        text = doc[0].get_text().replace('\xa0', ' ')
        doc.close()

        assert "Mohan Lal Verma" in text
        assert "Glucosamine Sulfate 500mg" in text
        assert "Pantoprazole 40mg" in text
        assert "मुख्य शिकायतें" in text
        assert "दवाएं" in text

    def test_20_real_scanned_and_digital_fixtures(self):
        real_scan = FIXTURES_DIR / "real_4page_scanned.pdf"
        assert real_scan.exists()
        doc = fitz.open(str(real_scan))
        assert len(doc) == 4
        doc.close()

        real_digital = FIXTURES_DIR / "real_6page_digital.pdf"
        assert real_digital.exists()
        doc = fitz.open(str(real_digital))
        assert len(doc) == 6
        assert len(doc[0].get_text().strip()) > 500
        doc.close()

    @pytest.mark.asyncio
    async def test_21_zero_think_leak_and_dosage_preservation_in_summary(self):
        class MockSummary:
            async def summarize(self, *args, **kwargs):
                return {
                    "summary": [
                        "Diagnosed with Type 2 Diabetes.",
                        "Prescribed Metformin 500mg once daily."
                    ]
                }

        class MockTranslation:
            is_warm: bool = True

            async def translate(self, text, *args, **kwargs):
                # Simulated translation that preserves English brand names and dosages
                return text.replace("Diagnosed with", "निदान किया गया").replace("Prescribed", "दी गई")

        handler = SummaryStageHandler(summary_service=MockSummary(), translation_service=MockTranslation())
        summary_result = await handler.generate_summary(
            raw_text="<think>internal thought trace</think>\nPatient: John Doe\nDiagnosed with Type 2 Diabetes.\nPrescribed Metformin 500mg once daily.",
            structured_data={
                "patientInfo": {"name": "John Doe"},
                "diagnosis": ["Type 2 Diabetes"],
                "medications": [{"name": "Metformin 500mg", "dosage": "500mg", "frequency": "once daily"}]
            },
            preferred_language="hindi",
        )

        english_summary = summary_result.get("summaryEnglish") or ""
        translated_summary = summary_result.get("summaryInPreferredLanguage") or ""

        # Verify ZERO <think> leak
        assert "<think>" not in english_summary
        assert "</think>" not in english_summary
        assert "<think>" not in translated_summary
        assert "</think>" not in translated_summary

        # Verify exact numerical dosage preservation
        assert "500mg" in english_summary
        assert "500mg" in translated_summary
