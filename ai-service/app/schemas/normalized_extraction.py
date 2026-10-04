from __future__ import annotations

from typing import Any
from pydantic import BaseModel, Field


class DocumentInfo(BaseModel):
    documentType: str = Field(default="UNKNOWN", description="Canonical document type, e.g., QUOTATION, PRESCRIPTION, LAB_REPORT")
    documentDate: str | None = Field(default=None, description="Explicit source date in ISO YYYY-MM-DD format")
    title: str | None = Field(default=None, description="Document title or header")
    language: str = Field(default="en", description="Primary document language code")
    rawClassification: str | None = Field(default=None, description="Raw model classification label")


class PatientInfo(BaseModel):
    firstName: str | None = Field(default=None, description="First name extracted from source")
    middleName: str | None = Field(default=None, description="Middle name extracted from source")
    lastName: str | None = Field(default=None, description="Last/surname extracted from source")
    fullName: str | None = Field(default=None, description="Verbatim full patient name preserved exactly as written")
    dateOfBirth: str | None = Field(default=None, description="Explicit date of birth (YYYY-MM-DD). NEVER derived from age")
    age: int | None = Field(default=None, description="Patient age in integer years")
    gender: str | None = Field(default=None, description="Normalized gender: MALE, FEMALE, OTHER")
    phone: str | None = Field(default=None, description="Patient contact telephone/mobile")
    email: str | None = Field(default=None, description="Patient email address")
    patientId: str | None = Field(default=None, description="Patient UHID, MRN, or record number")


class ProviderDetail(BaseModel):
    name: str | None = Field(default=None, description="Provider/Doctor full name")
    specialty: str | None = Field(default=None, description="Medical/dental specialty")
    registrationNumber: str | None = Field(default=None, description="Medical council registration number")
    phone: str | None = Field(default=None, description="Provider phone number")
    qualification: str | None = Field(default=None, description="Medical/dental degrees, e.g., BDS, MDS")
    isPrimary: bool = Field(default=False, description="Whether this provider is the primary attending clinician")


class ProviderInfo(BaseModel):
    primary: ProviderDetail | None = Field(default=None, description="Primary/attending provider if explicitly identified")
    providers: list[ProviderDetail] = Field(default_factory=list, description="All identified healthcare providers")


class FacilityInfo(BaseModel):
    name: str | None = Field(default=None, description="Clinic, hospital, or laboratory name")
    address: str | None = Field(default=None, description="Physical postal address")
    phone: str | None = Field(default=None, description="Facility contact telephone")
    email: str | None = Field(default=None, description="Facility email address")
    website: str | None = Field(default=None, description="Facility official website")


class DiagnosisItem(BaseModel):
    condition: str = Field(description="Clinical condition or disease name")
    icd10: str | None = Field(default=None, description="ICD-10 code if present")
    status: str | None = Field(default=None, description="PROVISIONAL, CONFIRMED, RESOLVED")
    notes: str | None = Field(default=None, description="Clinical impressions or staging")
    provenance: str = Field(default="primary_ocr", description="Extraction provenance: primary_ocr, vlm_fallback")
    verification_required: bool = Field(default=False, description="True if extracted via fallback vision model")


class SymptomItem(BaseModel):
    symptom: str = Field(description="Chief complaint or reported symptom")
    duration: str | None = Field(default=None, description="Symptom duration (e.g., 3 days)")
    severity: str | None = Field(default=None, description="MILD, MODERATE, SEVERE")


class VitalItem(BaseModel):
    name: str = Field(description="Vital sign name, e.g., Blood Pressure, SpO2, Heart Rate")
    value: Any = Field(default=None, description="Measured numerical or composite value")
    unit: str | None = Field(default=None, description="Measurement unit (e.g., mmHg, %, bpm)")
    interpretation: str | None = Field(default=None, description="NORMAL, HIGH, LOW")


class LabResultItem(BaseModel):
    testName: str = Field(description="Laboratory test/analyte name")
    value: Any = Field(default=None, description="Measured result value")
    unit: str | None = Field(default=None, description="Standard lab unit (e.g., mg/dL, gm%)")
    referenceRange: str | None = Field(default=None, description="Laboratory reference interval")
    flag: str | None = Field(default=None, description="In-code deterministic flag: NORMAL, LOW, HIGH, CRITICAL")
    canonicalKey: str | None = Field(default=None, description="Standardized clinical analyte key")
    rawValue: str | None = Field(default=None, description="Original unparsed value string")
    isAbnormal: bool = Field(default=False, description="True if flag is LOW, HIGH, or CRITICAL")
    isCritical: bool = Field(default=False, description="True if value is critically abnormal")
    provenance: str = Field(default="primary_ocr", description="Extraction provenance: primary_ocr, vlm_fallback")
    verification_required: bool = Field(default=False, description="True if extracted via fallback vision model")


class MedicationItem(BaseModel):
    name: str = Field(description="Medication brand or generic name")
    form: str | None = Field(default=None, description="TABLET, CAPSULE, SYRUP, INJECTION")
    dosage: str | None = Field(default=None, description="Strength/dosage (e.g., 500mg, 10ml)")
    frequency: str | None = Field(default=None, description="Intake schedule (e.g., 1-0-1, OD, BID)")
    duration: str | None = Field(default=None, description="Treatment course duration (e.g., 5 days)")
    instructions: str | None = Field(default=None, description="Dietary context (e.g., After meals)")
    provenance: str = Field(default="primary_ocr", description="Extraction provenance: primary_ocr, vlm_fallback")
    verification_required: bool = Field(default=False, description="True if extracted via fallback vision model or low-confidence crop")
    confidence: float | None = Field(default=None, description="Confidence score 0.0 - 1.0")


class ProcedureItem(BaseModel):
    name: str = Field(description="Name of performed or proposed surgical/clinical procedure")
    date: str | None = Field(default=None, description="Procedure date (ISO format)")
    site: str | None = Field(default=None, description="Anatomical site or arch (e.g., Upper Arch, Tooth #14)")
    findings: str | None = Field(default=None, description="Intra-operative or procedural findings")
    notes: str | None = Field(default=None, description="Technique or materials used")


class TreatmentItem(BaseModel):
    name: str = Field(description="Clinical or dental treatment name")
    description: str | None = Field(default=None, description="Detailed scope of treatment")
    status: str | None = Field(default="PROPOSED", description="PROPOSED, IN_PROGRESS, COMPLETED")
    toothNumber: str | None = Field(default=None, description="FDI or Universal tooth designation")
    site: str | None = Field(default=None, description="Anatomical region or dental arch")


class TreatmentPlanItem(BaseModel):
    phase: int | None = Field(default=1, description="Treatment sequence phase number")
    description: str = Field(description="Description of this phase of the treatment plan")
    proposedDate: str | None = Field(default=None, description="Target or proposed scheduled date")
    estimatedDuration: str | None = Field(default=None, description="Estimated duration (e.g., 3 months)")
    status: str | None = Field(default="PROPOSED", description="PROPOSED, COMPLETED, CANCELLED")


class FinancialLineItem(BaseModel):
    description: str = Field(description="Description of item, implant, prosthetic, or service")
    specification: str | None = Field(default=None, description="Technical specification or brand")
    quantity: float | int | None = Field(default=1, description="Quantity of units")
    unitCost: float | None = Field(default=None, description="Cost per unit")
    totalCost: float | None = Field(default=None, description="Total cost for line item")
    isOptional: bool = Field(default=False, description="True if item is conditional/optional")
    remarks: str | None = Field(default=None, description="Source remarks, e.g., 'OPTIONAL (IF NEEDED)'")


class FinancialSummary(BaseModel):
    currency: str = Field(default="INR", description="Three-letter ISO currency code, e.g. INR")
    mandatoryTotal: float | None = Field(default=None, description="Sum of non-optional items or explicit quotation total")
    optionalTotal: float | None = Field(default=None, description="Sum of explicitly optional items")
    estimatedTotal: float | None = Field(default=None, description="Mandatory/source estimated total (never includes optional items)")
    paymentTerms: str | None = Field(default=None, description="Payment schedule, advance, or deposit details")
    lineItems: list[FinancialLineItem] = Field(default_factory=list, description="Itemized billing/quotation entries")
    subtotal: float | None = Field(default=None, description="Pre-tax total for invoices")
    tax: float | None = Field(default=None, description="Tax or GST amount")
    discount: float | None = Field(default=None, description="Discount amount applied")
    paidAmount: float | None = Field(default=None, description="Amount already paid on receipts/invoices")
    balanceDue: float | None = Field(default=None, description="Outstanding balance due")


class AdditionalInformation(BaseModel):
    remarks: str | None = Field(default=None, description="General document remarks or notes")
    recommendations: list[str] = Field(default_factory=list, description="Clinical recommendations or advice")
    followUpDate: str | None = Field(default=None, description="Next scheduled appointment date")
    notes: str | None = Field(default=None, description="Any unclassified clinical or administrative notes")


class NormalizedExtractionDocument(BaseModel):
    documentInfo: DocumentInfo = Field(default_factory=DocumentInfo)
    patientInfo: PatientInfo = Field(default_factory=PatientInfo)
    providerInfo: ProviderInfo = Field(default_factory=ProviderInfo)
    facilityInfo: FacilityInfo = Field(default_factory=FacilityInfo)
    diagnosis: list[DiagnosisItem] = Field(default_factory=list)
    symptoms: list[SymptomItem] = Field(default_factory=list)
    vitals: list[VitalItem] = Field(default_factory=list)
    labResults: list[LabResultItem] = Field(default_factory=list)
    medications: list[MedicationItem] = Field(default_factory=list)
    procedures: list[ProcedureItem] = Field(default_factory=list)
    treatments: list[TreatmentItem] = Field(default_factory=list)
    treatmentPlan: list[TreatmentPlanItem] | dict[str, Any] | None = Field(default_factory=list)
    financialSummary: FinancialSummary | dict[str, Any] | None = Field(default_factory=FinancialSummary)
    additionalInformation: AdditionalInformation | dict[str, Any] | None = Field(default_factory=AdditionalInformation)


NormalizedMedicalDocumentExtraction = NormalizedExtractionDocument
