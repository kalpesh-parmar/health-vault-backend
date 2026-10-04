from __future__ import annotations

import pytest

from app.services.pipeline.clinical_stage import ClinicalStageHandler


@pytest.mark.asyncio
async def test_manjuben_ranoliya_dental_quotation_golden():
    """Verify dental quotation extraction against golden target values for Manjuben Ranoliya.pdf.
    
    Target:
    - Upper Arch: 6 implants, Lower Arch: 6 implants, Total: 12 implants = Rs. 2,40,000
    - Teeth: 24 DMLS Ceramic Screw-Retained Teeth = Rs. 1,80,000
    - Mandatory / Estimated Total = Rs. 4,20,000
    - Optional: 3D Guide (18,000) + Bone graft (10,000) = Rs. 28,000 optional
    - dateOfBirth is None (never derived from age 52)
    - 2 providers: Dr. Hardik Suvagiya (primary), Dr. Kinnari Markana
    - Clinical lists (diagnosis, medications, labResults, vitals) are empty arrays
    """
    handler = ClinicalStageHandler(extraction_service=None)

    raw_ocr = {
        "fullText": (
            "dente 32 Dental Care & Implant Centre\n"
            "Dr. Hardik Suvagiya B.D.S., M.D.S. (Oral & Maxillofacial Surgeon & Implantologist)\n"
            "Dr. Kinnari Markana B.D.S. (Dental Surgeon)\n"
            "Patient Name: Manjuben Ranoliya   Age: 52 Yrs   Sex: Female\n"
            "Date: 08/01/2025\n\n"
            "TREATMENT ESTIMATE / QUOTATION\n"
            "1. Full Mouth Dental Implants (All-on-6):\n"
            "   Upper Arch: 6 Implants\n"
            "   Lower Arch: 6 Implants\n"
            "   Total 12 Implants x Rs. 20,000 = Rs. 2,40,000/-\n"
            "2. Prosthesis: 24 DMLS Ceramic Screw-Retained Teeth\n"
            "   24 Units x Rs. 7,500 = Rs. 1,80,000/-\n\n"
            "Optional / Additional Procedures:\n"
            "- 3D Computer Guided Implant Surgical Guide: Rs. 18,000/-\n"
            "- Bone Grafting Material (NOVABONE PUTTY 0.5 CC): Rs. 10,000/-\n\n"
            "Total Estimated Treatment Cost: Rs. 4,20,000/-\n"
        ),
        "paragraphs": [],
    }

    result = await handler.extract_fields(raw_ocr)

    assert result is not None

    # 1. Document Info
    doc_info = result.get("documentInfo") or {}
    assert doc_info.get("documentType") == "QUOTATION"

    # 2. Patient Info
    patient_info = result.get("patientInfo") or {}
    assert patient_info.get("fullName") == "Manjuben Ranoliya"
    assert patient_info.get("age") == 52
    assert patient_info.get("gender") == "FEMALE"
    assert patient_info.get("dateOfBirth") is None, "dateOfBirth MUST be None (no inference from age)!"

    # 3. Provider Info
    provider_info = result.get("providerInfo") or {}
    assert provider_info.get("primary", {}).get("name") == "Dr. Hardik Suvagiya"
    providers = provider_info.get("providers") or []
    assert len(providers) >= 2
    provider_names = [p.get("name") for p in providers]
    assert "Dr. Hardik Suvagiya" in provider_names
    assert any("Kinnari Markana" in p for p in provider_names)

    # 4. Facility Info
    facility_info = result.get("facilityInfo") or {}
    assert "dente 32" in facility_info.get("name", "").lower()

    # 5. Financial Summary - Golden Numbers
    fin = result.get("financialSummary") or {}
    assert fin.get("mandatoryTotal") == 420000.0, f"Expected 420000.0, got {fin.get('mandatoryTotal')}"
    assert fin.get("optionalTotal") == 28000.0, f"Expected 28000.0, got {fin.get('optionalTotal')}"
    assert fin.get("estimatedTotal") == 420000.0, f"Expected 420000.0, got {fin.get('estimatedTotal')}"
    assert fin.get("currency") in ("INR", "₹")

    line_items = fin.get("lineItems") or []
    assert len(line_items) >= 4
    optional_items = [i for i in line_items if i.get("isOptional") is True]
    assert len(optional_items) == 2

    # 6. Treatments & Treatment Plan
    treatments = result.get("treatments") or []
    assert len(treatments) >= 2
    implant_treatment = next((t for t in treatments if "implant" in t.get("name", "").lower()), None)
    assert implant_treatment is not None
    assert implant_treatment.get("quantity") == 12

    teeth_treatment = next((t for t in treatments if "teeth" in t.get("name", "").lower() or "dmls" in t.get("name", "").lower()), None)
    assert teeth_treatment is not None
    assert teeth_treatment.get("quantity") == 24

    treatment_plan = result.get("treatmentPlan") or []
    phases = treatment_plan if isinstance(treatment_plan, list) else (treatment_plan.get("phases") or [])
    assert len(phases) >= 2

    # 7. Clinical lists MUST be empty for a quotation
    assert result.get("diagnosis") == []
    assert result.get("symptoms") == []
    assert result.get("vitals") == []
    assert result.get("labResults") == []
    assert result.get("medications") == []
