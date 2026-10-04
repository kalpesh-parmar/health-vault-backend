from __future__ import annotations

import pytest

from app.modules.extraction.service import (
    clean_and_normalize_14_sections,
    _normalize_patient_info,
    _normalize_provider_info,
    _normalize_facility_info,
    _normalize_financial_summary,
)
from app.schemas.normalized_extraction import NormalizedMedicalDocumentExtraction


def test_14_canonical_sections_schema_conformance():
    """Verify that clean_and_normalize_14_sections generates all 14 sections without duplicate top-level keys."""
    raw_data = {
        "documentInfo": {"documentType": "PRESCRIPTION", "documentDate": "2026-03-15"},
        "patientInfo": {"fullName": "Rajesh Patel", "age": 42, "gender": "Male"},
        "providerInfo": {
            "primary": {"name": "Dr. Sharma", "role": "Physician"},
            "providers": [{"name": "Dr. Sharma", "role": "Physician", "isPrimary": True}],
        },
        "facilityInfo": {"name": "Metro Clinic"},
        "diagnosis": [{"condition": "Hypertension"}],
        "symptoms": [{"symptom": "Headache"}],
        "vitals": [{"name": "BP", "value": "130/80"}],
        "labResults": [],
        "medications": [{"name": "Amlodipine", "dosage": "5mg"}],
        "procedures": [],
        "treatments": [],
        "treatmentPlan": {"phases": [], "followUpInstructions": ["Follow up in 2 weeks"]},
        "financialSummary": None,
        "additionalInformation": {"notes": "Patient advised low sodium diet"},
    }

    normalized = clean_and_normalize_14_sections(raw_data)

    expected_14_sections = [
        "documentInfo",
        "patientInfo",
        "providerInfo",
        "facilityInfo",
        "diagnosis",
        "symptoms",
        "vitals",
        "labResults",
        "medications",
        "procedures",
        "treatments",
        "treatmentPlan",
        "financialSummary",
        "additionalInformation",
    ]

    for section in expected_14_sections:
        assert section in normalized, f"Missing canonical section: {section}"

    # Verify no legacy duplicate top-level fields are injected
    forbidden_keys = ["doctorName", "hospitalName", "doctorInfo", "hospitalInfo", "patientName", "patientAge", "tests"]
    for key in forbidden_keys:
        assert key not in normalized, f"Forbidden duplicate key '{key}' found in normalized extraction!"

    # Verify Pydantic schema validation succeeds
    pydantic_obj = NormalizedMedicalDocumentExtraction.model_validate(normalized)
    assert pydantic_obj.patientInfo.fullName == "Rajesh Patel"
    assert pydantic_obj.providerInfo.primary.name == "Dr. Sharma"


def test_anti_dob_derivation_rule():
    """Verify that dateOfBirth is NEVER derived or inferred from age."""
    patient_raw = {
        "fullName": "Manjuben Ranoliya",
        "age": 52,
        "gender": "Female",
        "dateOfBirth": None,
    }

    normalized_patient = _normalize_patient_info(patient_raw)
    assert normalized_patient["age"] == 52
    assert normalized_patient["dateOfBirth"] is None, "dateOfBirth MUST remain None when only age is provided!"

    # Also test with empty string DOB
    patient_empty_dob = {
        "fullName": "Manjuben Ranoliya",
        "age": "52 Yrs",
        "gender": "F",
        "dateOfBirth": "",
    }
    normalized_empty = _normalize_patient_info(patient_empty_dob)
    assert normalized_empty["age"] == 52
    assert normalized_empty["dateOfBirth"] is None
    assert normalized_empty["gender"] == "FEMALE"


def test_patient_name_preservation_and_component_parsing():
    """Verify patient fullName is preserved verbatim and components parsed cleanly without fabrication."""
    patient_raw = {
        "fullName": "Suresh Kumar Sharma",
        "age": 35,
        "gender": "M",
    }
    normalized = _normalize_patient_info(patient_raw)
    assert normalized["fullName"] == "Suresh Kumar Sharma"
    assert normalized["firstName"] == "Suresh"
    assert normalized["middleName"] == "Kumar"
    assert normalized["lastName"] == "Sharma"

    # Single name
    single_name_raw = {"fullName": "Anil", "age": 28}
    norm_single = _normalize_patient_info(single_name_raw)
    assert norm_single["fullName"] == "Anil"
    assert norm_single["firstName"] == "Anil"
    assert norm_single["middleName"] is None
    assert norm_single["lastName"] is None


def test_multiple_provider_preservation():
    """Verify all practitioners are preserved in providerInfo.providers and primary provider is identified."""
    provider_raw = {
        "primary": {"name": "Dr. Hardik Suvagiya", "qualifications": ["B.D.S.", "M.D.S."], "specialty": "Implantologist"},
        "providers": [
            {"name": "Dr. Hardik Suvagiya", "qualifications": ["B.D.S.", "M.D.S."], "isPrimary": True},
            {"name": "Dr. Kinnari Markana", "qualifications": ["B.D.S."], "isPrimary": False},
        ],
    }

    normalized = _normalize_provider_info(provider_raw)
    assert normalized["primary"]["name"] == "Dr. Hardik Suvagiya"
    assert len(normalized["providers"]) == 2
    assert normalized["providers"][0]["name"] == "Dr. Hardik Suvagiya"
    assert normalized["providers"][0]["isPrimary"] is True
    assert normalized["providers"][1]["name"] == "Dr. Kinnari Markana"
    assert normalized["providers"][1]["isPrimary"] is False


def test_quotation_financial_arithmetic():
    """Verify deterministic financial arithmetic separates mandatory and optional items and never adds optional items to estimatedTotal."""
    fin_raw = {
        "currency": "INR",
        "lineItems": [
            {
                "description": "Implants All-on-6 (Upper and Lower arches)",
                "category": "IMPLANT",
                "quantity": 12,
                "unitPrice": 20000.0,
                "totalPrice": 240000.0,
                "isOptional": False,
            },
            {
                "description": "DMLS Ceramic Screw-Retained Teeth",
                "category": "PROSTHESIS",
                "quantity": 24,
                "unitPrice": 7500.0,
                "totalPrice": 180000.0,
                "isOptional": False,
            },
            {
                "description": "3D Surgical Guide",
                "category": "GUIDE",
                "quantity": 1,
                "unitPrice": 18000.0,
                "totalPrice": 18000.0,
                "isOptional": True,
            },
            {
                "description": "Bone Graft NOVABONE PUTTY 0.5 CC",
                "category": "GRAFT",
                "quantity": 1,
                "unitPrice": 10000.0,
                "totalPrice": 10000.0,
                "isOptional": True,
            },
        ],
    }

    normalized = _normalize_financial_summary(fin_raw, document_type="QUOTATION")

    assert normalized is not None
    # Mandatory total: 240,000 + 180,000 = 420,000
    assert normalized["mandatoryTotal"] == 420000.0
    # Optional total: 18,000 + 10,000 = 28,000
    assert normalized["optionalTotal"] == 28000.0
    # Estimated total MUST strictly equal mandatory total (excluding optional items)
    assert normalized["estimatedTotal"] == 420000.0
    assert normalized["currency"] == "INR"
    assert len(normalized["lineItems"]) == 4
