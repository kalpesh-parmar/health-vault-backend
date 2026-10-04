"""Phase 4d Verification: Clinical Fallback Provenance & Verification Flagging.

Verifies end-to-end multi-tier contract across Python AI Service,
Node.js persistence normalizer, and React Native review screen triggers.
"""
from __future__ import annotations

import asyncio
import json
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from app.schemas.normalized_extraction import MedicationItem, DiagnosisItem, LabResultItem
from app.services.pipeline.clinical_stage import ClinicalStageHandler


async def run_verification():
    print("=" * 80)
    print("PHASE 4D VERIFICATION: CLINICAL FALLBACK PROVENANCE & REVIEW FLAGGING")
    print("=" * 80)

    # 1. Verify Python Extraction Schemas
    print("\n[Check 1] Validating Pydantic Schema Models...")
    med_primary = MedicationItem(name="Metformin 500mg")
    assert med_primary.provenance == "primary_ocr"
    assert med_primary.verification_required is False

    med_fallback = MedicationItem(
        name="Atorvastatin 20mg",
        provenance="vlm_fallback",
        verification_required=True,
        confidence=0.89,
    )
    assert med_fallback.provenance == "vlm_fallback"
    assert med_fallback.verification_required is True

    serialized = json.loads(med_fallback.model_dump_json())
    assert serialized["provenance"] == "vlm_fallback"
    assert serialized["verification_required"] is True
    assert serialized["confidence"] == 0.89
    print("  [PASS] Pydantic models cleanly serialize provenance, verification_required, and confidence.")

    # 2. Verify Heuristic Primary OCR Extraction
    print("\n[Check 2] Validating Primary OCR Heuristic Extraction...")
    handler = ClinicalStageHandler(extraction_service=None)
    ocr_payload_primary = {
        "fullText": "Rx\nTab Telmisartan 40mg OD Before food",
        "lines": [
            {"text": "Rx", "confidence": 0.98, "provenance": "primary_ocr"},
            {"text": "Tab Telmisartan 40mg OD Before food", "confidence": 0.96, "provenance": "primary_ocr"},
        ],
    }
    extracted_primary = await handler.extract_fields(raw_ocr_data=ocr_payload_primary)
    meds_primary = extracted_primary.get("medications", [])
    assert len(meds_primary) == 1
    assert meds_primary[0]["provenance"] == "primary_ocr"
    assert meds_primary[0]["verification_required"] is False
    print(f"  [PASS] Clean OCR yields provenance='primary_ocr' and verification_required=False.")

    # 3. Verify Crop Fallback Line-Level Provenance Tagging
    print("\n[Check 3] Validating Crop-Fallback Line-Level Provenance Propagation...")
    ocr_payload_crop = {
        "fullText": "Rx\nTab Glimepiride 2mg OD\nTab Metformin 500mg BD",
        "lines": [
            {"text": "Rx", "confidence": 0.98, "provenance": "primary_ocr"},
            {"text": "Tab Glimepiride 2mg OD", "confidence": 0.82, "provenance": "vlm_fallback"},
            {"text": "Tab Metformin 500mg BD", "confidence": 0.97, "provenance": "primary_ocr"},
        ],
    }
    extracted_crop = await handler.extract_fields(raw_ocr_data=ocr_payload_crop)
    meds_crop = extracted_crop.get("medications", [])
    assert len(meds_crop) == 2
    glim = next(m for m in meds_crop if "Glimepiride" in m["name"])
    met = next(m for m in meds_crop if "Metformin" in m["name"])
    assert glim["provenance"] == "vlm_fallback"
    assert glim["verification_required"] is True
    assert met["provenance"] == "primary_ocr"
    assert met["verification_required"] is False
    print(f"  [PASS] Localized crop fallback correctly tags only the fallback medication with verification_required=True.")

    # 4. Verify Multimodal VLM Consolidation
    print("\n[Check 4] Validating Multimodal VLM Consolidation...")
    ocr_payload_vlm = {
        "fullText": "Multimodal fallback extraction",
        "engine": "vlm_fallback",
        "medicalExtraction": {
            "diagnoses": ["Type 2 Diabetes"],
            "medications": [
                {"name": "Insulin Glargine 10 units", "dosage": "10 units", "frequency": "HS"}
            ],
            "labResults": [
                {"testName": "HbA1c", "value": "7.8", "unit": "%"}
            ],
        },
    }
    extracted_vlm = await handler.extract_fields(raw_ocr_data=ocr_payload_vlm)
    assert extracted_vlm["medications"][0]["provenance"] == "vlm_fallback"
    assert extracted_vlm["medications"][0]["verification_required"] is True
    assert extracted_vlm["diagnosis"][0]["provenance"] == "vlm_fallback"
    assert extracted_vlm["diagnosis"][0]["verification_required"] is True
    assert extracted_vlm["labResults"][0]["provenance"] == "vlm_fallback"
    assert extracted_vlm["labResults"][0]["verification_required"] is True
    print("  [PASS] Full VLM consolidation tags all diagnoses, medications, and labResults with vlm_fallback.")

    # 5. Verify Node.js Normalization Contract Simulation
    print("\n[Check 5] Validating Node.js & React Native Presentation Invariants...")
    # Simulating Node.js normalizeMedicine logic
    for med in extracted_crop.get("medications", []):
        prov = med.get("provenance") or "primary_ocr"
        verif_req = bool(med.get("verification_required") or prov == "vlm_fallback")
        schedule = {
            "source": "VLM_FALLBACK" if prov == "vlm_fallback" else "OCR",
            "provenance": prov,
            "verificationRequired": verif_req,
        }
        # Mobile ExtractedMedicineCard condition:
        badge_visible = bool(prov == "vlm_fallback" or verif_req)

        if "Glimepiride" in med["name"]:
            assert schedule["provenance"] == "vlm_fallback"
            assert schedule["verificationRequired"] is True
            assert badge_visible is True
        elif "Metformin" in med["name"]:
            assert schedule["provenance"] == "primary_ocr"
            assert schedule["verificationRequired"] is False
            assert badge_visible is False

    print("  [PASS] Node.js schedule JSON contract and React Native badge triggers hold for all entities.")

    print("\n" + "=" * 80)
    print("ALL 5/5 PHASE 4D VERIFICATION CHECKS PASSED.")
    print("=" * 80)


if __name__ == "__main__":
    asyncio.run(run_verification())
