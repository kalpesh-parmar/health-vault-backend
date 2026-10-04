import pytest
from app.schemas.normalized_extraction import (
    MedicationItem,
    DiagnosisItem,
    LabResultItem,
    NormalizedMedicalDocumentExtraction,
)
from app.services.pipeline.clinical_stage import ClinicalStageHandler


def test_medication_item_schema_defaults_and_custom():
    # Test defaults
    med_default = MedicationItem(name="Paracetamol 500mg")
    assert med_default.provenance == "primary_ocr"
    assert med_default.verification_required is False
    assert med_default.confidence is None

    # Test custom fallback provenance
    med_fallback = MedicationItem(
        name="Amoxicillin 500mg",
        provenance="vlm_fallback",
        verification_required=True,
        confidence=0.92,
    )
    assert med_fallback.provenance == "vlm_fallback"
    assert med_fallback.verification_required is True
    assert med_fallback.confidence == 0.92


def test_diagnosis_and_lab_item_schema():
    diag = DiagnosisItem(condition="Hypertension", provenance="vlm_fallback", verification_required=True)
    assert diag.provenance == "vlm_fallback"
    assert diag.verification_required is True

    lab = LabResultItem(testName="Hemoglobin", provenance="primary_ocr", verification_required=False)
    assert lab.provenance == "primary_ocr"
    assert lab.verification_required is False


@pytest.mark.asyncio
async def test_clinical_stage_heuristic_primary_ocr_provenance():
    stage = ClinicalStageHandler(extraction_service=None)
    raw_ocr_data = {
        "fullText": "Rx\nTab Paracetamol 500mg 1-0-1 After meals",
        "lines": [
            {"text": "Rx", "confidence": 0.98, "provenance": "primary_ocr"},
            {"text": "Tab Paracetamol 500mg 1-0-1 After meals", "confidence": 0.95, "provenance": "primary_ocr"},
        ],
    }

    result = await stage.extract_fields(raw_ocr_data=raw_ocr_data)
    meds = result.get("medications", [])
    assert len(meds) == 1
    med = meds[0]
    assert "Paracetamol" in med["name"]
    assert med["provenance"] == "primary_ocr"
    assert med["verification_required"] is False


@pytest.mark.asyncio
async def test_clinical_stage_heuristic_crop_fallback_provenance():
    stage = ClinicalStageHandler(extraction_service=None)
    raw_ocr_data = {
        "fullText": "Rx\nTab Azithromycin 500mg OD\nTab Pantocid 40mg OD",
        "lines": [
            {"text": "Rx", "confidence": 0.98, "provenance": "primary_ocr"},
            {"text": "Tab Azithromycin 500mg OD", "confidence": 0.88, "provenance": "vlm_fallback"},
            {"text": "Tab Pantocid 40mg OD", "confidence": 0.95, "provenance": "primary_ocr"},
        ],
    }

    result = await stage.extract_fields(raw_ocr_data=raw_ocr_data)
    meds = result.get("medications", [])
    assert len(meds) == 2

    azithro = next(m for m in meds if "Azithromycin" in m["name"])
    assert azithro["provenance"] == "vlm_fallback"
    assert azithro["verification_required"] is True

    panto = next(m for m in meds if "Pantocid" in m["name"])
    assert panto["provenance"] == "primary_ocr"
    assert panto["verification_required"] is False


@pytest.mark.asyncio
async def test_clinical_stage_consolidate_vlm_fallback_provenance():
    stage = ClinicalStageHandler(extraction_service=None)
    raw_ocr_data = {
        "fullText": "Full page scanned Hindi prescription",
        "engine": "vlm_fallback",
        "medicalExtraction": {
            "diagnoses": ["Acute Bronchitis"],
            "medications": [
                {
                    "name": "Augmentin 625mg",
                    "dosage": "625mg",
                    "frequency": "BID",
                    "instructions": "After food",
                }
            ],
            "labResults": [
                {
                    "testName": "CRP",
                    "value": "12",
                    "unit": "mg/L",
                }
            ],
        },
    }

    result = await stage.extract_fields(raw_ocr_data=raw_ocr_data)
    meds = result.get("medications", [])
    assert len(meds) == 1
    assert meds[0]["name"] == "Augmentin 625mg"
    assert meds[0]["provenance"] == "vlm_fallback"
    assert meds[0]["verification_required"] is True

    diags = result.get("diagnosis", [])
    assert len(diags) == 1
    assert diags[0]["condition"] == "Acute Bronchitis"
    assert diags[0]["provenance"] == "vlm_fallback"
    assert diags[0]["verification_required"] is True

    labs = result.get("labResults", [])
    assert len(labs) == 1
    assert labs[0]["testName"] == "CRP"
    assert labs[0]["provenance"] == "vlm_fallback"
    assert labs[0]["verification_required"] is True
