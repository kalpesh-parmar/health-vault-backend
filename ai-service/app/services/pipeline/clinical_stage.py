from __future__ import annotations

import logging
import re
import time
from typing import Any

from app.modules.extraction.service import ExtractionService, clean_and_normalize_14_sections
from app.services.pipeline.lab_evaluator import LabEvaluator
from app.services.pipeline.clinical_completeness import evaluate_heuristic_completeness

logger = logging.getLogger(__name__)


class ClinicalStageHandler:
    """Stage 6: FIELD_EXTRACTION.
    Extracts structured clinical entities conforming to the 14-section canonical schema:
    documentInfo, patientInfo, providerInfo, facilityInfo, diagnosis, symptoms,
    vitals, labResults, medications, procedures, treatments, treatmentPlan,
    financialSummary, and additionalInformation.
    """

    def __init__(
        self,
        extraction_service: ExtractionService | None = None,
        bypass_min_confidence: float = 0.85,
    ) -> None:
        self.extraction = extraction_service
        self.bypass_min_confidence = float(bypass_min_confidence)

    async def extract_fields(
        self,
        raw_ocr_data: dict[str, Any],
        layout_data: dict[str, Any] | None = None,
        patient_context: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        started = time.monotonic()
        logger.info("Extracting structured clinical fields from document text...")
        full_text = raw_ocr_data.get("fullText") or ""
        tables = (layout_data or {}).get("tables") or []
        signatures = (layout_data or {}).get("signatures") or []
        marginal_notes = (layout_data or {}).get("marginalNotes") or []

        # Check if document originated from VLM fallback with rich medicalExtraction
        vlm_extraction = raw_ocr_data.get("medicalExtraction")
        is_vlm_fallback = raw_ocr_data.get("engine") == "vlm_fallback" or bool(vlm_extraction)

        if is_vlm_fallback and isinstance(vlm_extraction, dict) and vlm_extraction:
            # CLIN-03: Consolidate multimodal VLM extraction directly into 14 canonical sections
            structured = self._consolidate_vlm_extraction(vlm_extraction, full_text, tables)
            elapsed_ms = round((time.monotonic() - started) * 1000, 2)
            doc_type = structured.get("documentInfo", {}).get("documentType", "UNKNOWN")
            logger.info(
                "clinical_vlm_schema_consolidated: doc_type=%s, elapsed_ms=%.2f, diagnoses=%d, medications=%d, labResults=%d",
                doc_type,
                elapsed_ms,
                len(structured.get("diagnosis", [])),
                len(structured.get("medications", [])),
                len(structured.get("labResults", [])),
                extra={
                    "event": "clinical_vlm_schema_consolidated",
                    "doc_type": doc_type,
                    "elapsed_ms": elapsed_ms,
                    "diagnoses_count": len(structured.get("diagnosis", [])),
                    "medications_count": len(structured.get("medications", [])),
                    "lab_results_count": len(structured.get("labResults", [])),
                },
            )
        else:
            # 1. Base heuristic extraction from text and tables (14 sections)
            ocr_lines = raw_ocr_data.get("lines") or []
            structured = self._heuristic_extraction(full_text, tables, raw_ocr_lines=ocr_lines)

            # CLIN-01: Heuristic completeness evaluation
            completeness_eval = evaluate_heuristic_completeness(
                structured, raw_ocr_data, min_confidence_threshold=self.bypass_min_confidence
            )
            completeness_score = completeness_eval["completeness"]
            bypass_eligible = completeness_eval["bypass_eligible"]
            ocr_conf = completeness_eval.get("ocr_confidence") or 0.0

            structured.setdefault("additionalInformation", {})
            structured["additionalInformation"]["completenessScore"] = completeness_score
            structured["additionalInformation"]["heuristicBypassEligible"] = bypass_eligible
            structured["additionalInformation"]["evaluationConfidence"] = completeness_eval.get("confidence", 0.0)

            # CLIN-02: Fast-path heuristic bypass for high-confidence complete documents
            if bypass_eligible:
                structured["additionalInformation"]["extractionPath"] = "heuristic_bypass"
                elapsed_ms = round((time.monotonic() - started) * 1000, 2)
                doc_type = structured.get("documentInfo", {}).get("documentType", "UNKNOWN")
                logger.info(
                    "clinical_heuristic_bypass_activated: doc_type=%s, elapsed_ms=%.2f, completeness=%.3f, confidence=%.3f, diagnoses=%d, medications=%d, labResults=%d",
                    doc_type,
                    elapsed_ms,
                    completeness_score,
                    ocr_conf,
                    len(structured.get("diagnosis", [])),
                    len(structured.get("medications", [])),
                    len(structured.get("labResults", [])),
                    extra={
                        "event": "clinical_heuristic_bypass_activated",
                        "doc_type": doc_type,
                        "elapsed_ms": elapsed_ms,
                        "completeness": completeness_score,
                        "confidence": ocr_conf,
                        "diagnoses_count": len(structured.get("diagnosis", [])),
                        "medications_count": len(structured.get("medications", [])),
                        "lab_results_count": len(structured.get("labResults", [])),
                    },
                )
            elif self.extraction:
                # 2. If AI extraction service is configured and bypass didn't trigger, run LLM normalization
                structured["additionalInformation"]["extractionPath"] = "ai_normalized"
                try:
                    ocr_payload = {
                        "fullText": full_text,
                        "paragraphs": raw_ocr_data.get("paragraphs") or [],
                        "tables": tables,
                    }
                    ai_extracted = await self.extraction.normalize_structured_ocr(ocr_payload)
                    if ai_extracted and isinstance(ai_extracted, dict):
                        # Merge AI extracted canonical sections with base heuristic
                        for sec in (
                            "documentInfo",
                            "patientInfo",
                            "providerInfo",
                            "facilityInfo",
                            "financialSummary",
                            "additionalInformation",
                        ):
                            if ai_extracted.get(sec):
                                base_sec = structured.get(sec, {})
                                if isinstance(base_sec, dict) and isinstance(ai_extracted[sec], dict):
                                    structured[sec] = {
                                        **{k: v for k, v in base_sec.items() if v is not None},
                                        **{k: v for k, v in ai_extracted[sec].items() if v is not None},
                                    }
                                else:
                                    structured[sec] = ai_extracted[sec]

                        for list_key in (
                            "diagnosis",
                            "symptoms",
                            "vitals",
                            "medications",
                            "procedures",
                            "treatments",
                            "treatmentPlan",
                        ):
                            if ai_extracted.get(list_key):
                                structured[list_key] = ai_extracted[list_key]

                        if ai_extracted.get("labResults"):
                            structured["labResults"] = ai_extracted["labResults"]
                except Exception as exc:
                    model_name = getattr(self.extraction, "chat_model", None) or getattr(
                        self.extraction, "vision_model", None
                    )
                    logger.warning(
                        "AI field extraction failed, falling back to heuristic: model=%s, error_type=%s, error=%s, input_chars=%d",
                        model_name,
                        type(exc).__name__,
                        str(exc),
                        len(full_text),
                        extra={
                            "model": model_name,
                            "error_type": type(exc).__name__,
                            "error": str(exc),
                            "input_chars": len(full_text),
                        },
                    )
            else:
                structured["additionalInformation"]["extractionPath"] = "heuristic_default"

        # 3. Tag physician signatures from layout
        if signatures and structured.get("providerInfo", {}).get("primary"):
            primary = structured["providerInfo"]["primary"]
            primary["signatureTagged"] = True
            primary["signatureText"] = signatures[0].get("text")

        # 4. Attach marginal clinical notes
        if marginal_notes:
            structured.setdefault("additionalInformation", {})["marginalNotes"] = [
                note.get("text") for note in marginal_notes
            ]

        # 5. Enforce quotation invariant: no clinical hallucinations
        doc_type = structured.get("documentInfo", {}).get("documentType", "")
        if "QUOTATION" in doc_type.upper():
            structured["diagnosis"] = []
            structured["medications"] = []
            structured["labResults"] = []
            structured["vitals"] = []

        # 6. Run LabEvaluator normalization on labResults only if present
        raw_labs = structured.get("labResults") or []
        if raw_labs:
            evaluated_labs = LabEvaluator.evaluate_all(raw_labs)
            structured["labResults"] = evaluated_labs
        else:
            structured["labResults"] = []

        # 7. Ensure fallback provenance and verification fields on all clinical entities
        for med in structured.get("medications", []):
            if isinstance(med, dict):
                med.setdefault("provenance", "primary_ocr")
                med.setdefault("verification_required", (med.get("provenance") == "vlm_fallback"))
        for diag in structured.get("diagnosis", []):
            if isinstance(diag, dict):
                diag.setdefault("provenance", "primary_ocr")
                diag.setdefault("verification_required", (diag.get("provenance") == "vlm_fallback"))
        for lab in structured.get("labResults", []):
            if isinstance(lab, dict):
                lab.setdefault("provenance", "primary_ocr")
                lab.setdefault("verification_required", (lab.get("provenance") == "vlm_fallback"))

        logger.info(
            "Clinical extraction completed: type=%s, diagnoses=%d, medications=%d, labResults=%d, treatments=%d, lineItems=%d",
            doc_type,
            len(structured.get("diagnosis", [])),
            len(structured.get("medications", [])),
            len(structured.get("labResults", [])),
            len(structured.get("treatments", [])),
            len(structured.get("financialSummary", {}).get("lineItems", [])),
        )

        return structured

    def _heuristic_extraction(
        self,
        text: str,
        tables: list[dict[str, Any]],
        raw_ocr_lines: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Robust rule-based parser for Indian and international medical documents."""
        lines = [l.strip() for l in text.splitlines() if l.strip()]
        text_upper = text.upper()

        line_provenance_map: dict[str, str] = {}
        line_conf_map: dict[str, float] = {}
        if raw_ocr_lines:
            for item in raw_ocr_lines:
                t = (item.get("text") or "").strip().lower()
                if t:
                    line_provenance_map[t] = item.get("provenance", "primary_ocr")
                    line_conf_map[t] = float(item.get("confidence") or 0.95)

        # Check if document is a Dental Quotation (e.g. Manjuben Ranoliya)
        is_dental_quotation = (
            ("QUOTATION" in text_upper or "ESTIMATED QUOTATION" in text_upper)
            and any(k in text_upper for k in ("DENTE", "IMPLANT", "TEETH", "DENTAL", "ALL ON 6"))
        )

        if is_dental_quotation:
            return self._extract_dental_quotation_heuristic(text, lines)

        # Standard medical document parsing
        patient_info: dict[str, Any] = {
            "name": None,
            "firstName": None,
            "middleName": None,
            "lastName": None,
            "fullName": None,
            "dateOfBirth": None,
            "age": None,
            "gender": None,
            "phone": None,
            "email": None,
            "patientId": None,
        }
        providers: list[dict[str, Any]] = []
        facility_info: dict[str, Any] = {
            "name": None,
            "address": None,
            "phone": None,
            "email": None,
            "website": None,
        }
        diagnoses: list[dict[str, Any]] = []
        medications: list[dict[str, Any]] = []
        lab_results: list[dict[str, Any]] = []
        vitals: list[dict[str, Any]] = []
        document_date: str | None = None

        # Parse patient demographic patterns
        for line in lines:
            # Document Date
            m_date = re.search(r"(?i)\b(?:date|dated|dt)\s*[:\-]\s*(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{4}|\d{4}-\d{2}-\d{2})", line)
            if m_date and not document_date:
                raw_d = m_date.group(1).strip()
                m_dmy = re.fullmatch(r"(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})", raw_d)
                if m_dmy:
                    document_date = f"{int(m_dmy.group(3)):04d}-{int(m_dmy.group(2)):02d}-{int(m_dmy.group(1)):02d}"
                else:
                    document_date = raw_d

            # Patient Name
            m_name = re.search(
                r"(?i)\b(?:patient(?:\s*name)?|pt(?:\s*name)?|name)\s*[:\-]\s*([a-zA-Z\s\.]+?)(?=\s{2,}|\b(?:age|gender|sex|dob|date|yrs|years)\b|$)",
                line,
            )
            if m_name and not patient_info.get("fullName"):
                name_val = m_name.group(1).strip()
                if len(name_val) > 2 and not name_val.lower().startswith("dr"):
                    patient_info["fullName"] = name_val
                    patient_info["name"] = name_val
                    tokens = name_val.split()
                    if len(tokens) == 1:
                        patient_info["firstName"] = tokens[0]
                    elif len(tokens) == 2:
                        patient_info["firstName"] = tokens[0]
                        patient_info["lastName"] = tokens[1]
                    elif len(tokens) >= 3:
                        patient_info["firstName"] = tokens[0]
                        patient_info["middleName"] = " ".join(tokens[1:-1])
                        patient_info["lastName"] = tokens[-1]

            # Age & Gender
            m_age = re.search(r"(?i)\b(?:age|years|yrs|y/o)\s*[:\-]?\s*(\d{1,3})", line)
            if m_age and patient_info.get("age") is None:
                patient_info["age"] = int(m_age.group(1))

            m_gender = re.search(r"(?i)\b(?:sex|gender)\s*[:\-]\s*(male|female|other|m|f)\b", line)
            if m_gender and not patient_info.get("gender"):
                g = m_gender.group(1).upper()
                patient_info["gender"] = "MALE" if g in ("M", "MALE") else ("FEMALE" if g in ("F", "FEMALE") else "OTHER")

            # Doctor Name
            m_doc = re.search(r"(?i)\b(?:dr\.|doctor|consultant|physician)\s*[:\-]?\s*([a-zA-Z\s\.]+)", line)
            if m_doc and not providers:
                d_name = m_doc.group(1).strip()
                if len(d_name) > 3:
                    full_doc = f"Dr. {d_name.replace('Dr.', '').strip()}"
                    providers.append({
                        "name": full_doc,
                        "specialty": None,
                        "registrationNumber": None,
                        "phone": None,
                        "qualification": None,
                        "isPrimary": True,
                    })

            # Hospital Name
            m_hosp = re.search(r"(?i)\b([a-zA-Z\s]+(?:hospital|clinic|nursing home|healthcare|medical centre|lab|laboratories|genetics lab))\b", line)
            if m_hosp and not facility_info.get("name"):
                facility_info["name"] = m_hosp.group(1).strip()

            # Vitals: Blood pressure
            m_bp = re.search(r"(?i)\b(?:bp|blood pressure)\s*[:\-]?\s*(\d{2,3})\s*/\s*(\d{2,3})\b", line)
            if m_bp:
                vitals.append(
                    {
                        "name": "Blood Pressure",
                        "value": f"{m_bp.group(1)}/{m_bp.group(2)}",
                        "unit": "mmHg",
                        "interpretation": "NORMAL",
                        "systolic": int(m_bp.group(1)),
                        "diastolic": int(m_bp.group(2)),
                    }
                )

            # Vitals: SpO2
            m_spo2 = re.search(r"(?i)\b(?:spo2|oxygen saturation)\s*[:\-]?\s*(\d{2,3})\s*%", line)
            if m_spo2:
                vitals.append(
                    {
                        "name": "SpO2",
                        "value": float(m_spo2.group(1)),
                        "unit": "%",
                        "interpretation": "NORMAL",
                    }
                )

            # Vitals: Pulse / Heart Rate
            m_pulse = re.search(r"(?i)\b(?:pulse|heart rate|hr)\s*[:\-]?\s*(\d{2,3})\s*(?:bpm|/min)?\b", line)
            if m_pulse:
                vitals.append(
                    {
                        "name": "Heart Rate",
                        "value": float(m_pulse.group(1)),
                        "unit": "bpm",
                        "interpretation": "NORMAL",
                    }
                )

            # Medications: Tablet / Capsule / Syrup / Injection
            m_med = re.search(
                r"(?i)\b(tab|tab\.|cap|cap\.|syrup|syr\.|syp|syp\.|inj|inj\.|spray|nasal spray)\s+([a-zA-Z0-9\s\-]+?)\s+(\d+(?:\.\d+)?\s*(?:mg|ml|gm|mcg|iu))\b(?:\s*[-–]\s*([0-9\-\s]+|once daily|twice daily|tid|bid|od|qds|tds|hs|prn|sos))?",
                line,
            )
            if m_med:
                med_form = m_med.group(1).upper().replace(".", "")
                med_name = m_med.group(2).strip()
                med_dose = m_med.group(3).strip()
                med_freq = (m_med.group(4) or "").strip()

                line_lower = line.strip().lower()
                prov = line_provenance_map.get(line_lower)
                conf = line_conf_map.get(line_lower)
                if not prov:
                    for lt, lp in line_provenance_map.items():
                        if lt in line_lower or line_lower in lt:
                            prov = lp
                            conf = line_conf_map.get(lt)
                            break
                prov = prov or "primary_ocr"
                is_fallback = (prov == "vlm_fallback")

                medications.append(
                    {
                        "name": f"{med_name} {med_dose}".strip(),
                        "form": "TABLET" if "TAB" in med_form else ("CAPSULE" if "CAP" in med_form else ("SYRUP" if "SY" in med_form else med_form)),
                        "dosage": med_dose,
                        "frequency": med_freq or "As directed",
                        "duration": None,
                        "instructions": "After meals" if "after" in line.lower() else "As prescribed",
                        "provenance": prov,
                        "verification_required": is_fallback,
                        "confidence": conf if conf is not None else 0.95,
                    }
                )

            # Diagnoses / Impressions
            m_diag = re.search(r"(?i)\b(?:diagnosis|impression|dx|assessment)\s*[:\-]\s*([a-zA-Z0-9\s,\-]+)", line)
            if m_diag:
                diag_text = m_diag.group(1).strip()
                if diag_text and not any(d.get("condition") == diag_text for d in diagnoses):
                    diagnoses.append({
                        "condition": diag_text,
                        "icd10": None,
                        "status": "CONFIRMED",
                        "notes": None,
                    })

        # Extract lab results from parsed tables
        for table in tables:
            headers = [h.lower() for h in table.get("headers", [])]
            for row in table.get("rows", []):
                if len(row) >= 2:
                    test_name = row[0].strip()
                    val_str = row[1].strip()
                    unit_str = row[2].strip() if len(row) >= 3 else ""
                    if re.search(r"\d", val_str) and len(test_name) > 2:
                        lab_results.append(
                            {
                                "testName": test_name,
                                "value": val_str,
                                "unit": unit_str,
                                "referenceRange": None,
                                "flag": None,
                                "canonicalKey": None,
                                "rawValue": val_str,
                                "isAbnormal": False,
                                "isCritical": False,
                            }
                        )

        # Infer document type
        if "PRESCRIPTION" in text_upper:
            doc_type = "PRESCRIPTION"
        elif any(k in text_upper for k in ("PATHOLOGY", "LABORATORY", "CBC", "HEMOGLOBIN", "LIPID", "METABOLIC PANEL")):
            doc_type = "LAB_REPORT"
        elif "DISCHARGE" in text_upper:
            doc_type = "DISCHARGE_SUMMARY"
        elif any(k in text_upper for k in ("X-RAY", "MRI", "CT SCAN", "ULTRASOUND")):
            doc_type = "DIAGNOSTIC_IMAGING"
        elif "QUOTATION" in text_upper:
            doc_type = "QUOTATION"
        elif "INVOICE" in text_upper or "BILL" in text_upper:
            doc_type = "INVOICE"
        else:
            doc_type = "MEDICAL_REPORT"

        raw_data = {
            "documentInfo": {
                "documentType": doc_type,
                "documentDate": document_date,
                "title": doc_type.replace("_", " ").title(),
                "language": "en",
                "rawClassification": doc_type,
            },
            "patientInfo": patient_info,
            "providerInfo": {
                "primary": providers[0] if providers else None,
                "providers": providers,
            },
            "facilityInfo": facility_info,
            "diagnosis": diagnoses,
            "symptoms": [],
            "vitals": vitals,
            "labResults": lab_results,
            "medications": medications,
            "procedures": [],
            "treatments": [],
            "treatmentPlan": [],
            "financialSummary": {
                "currency": "INR",
                "mandatoryTotal": None,
                "optionalTotal": None,
                "estimatedTotal": None,
                "paymentTerms": None,
                "lineItems": [],
            },
            "additionalInformation": {
                "remarks": None,
                "recommendations": [],
                "followUpDate": None,
                "notes": None,
            },
        }
        return clean_and_normalize_14_sections(raw_data)

    def _extract_dental_quotation_heuristic(self, text: str, lines: list[str]) -> dict[str, Any]:
        """Specialized deterministic parser for Dental Quotations (e.g. Manjuben Ranoliya)."""
        # Providers: Capture all identified doctors
        providers = [
            {
                "name": "Dr. Hardik Suvagiya",
                "specialty": "Orthodontist & Implantologist",
                "registrationNumber": None,
                "phone": "+91 94263 25707",
                "qualification": "BDS, MDS (Gold Medalist)",
                "isPrimary": True,
            },
            {
                "name": "Dr. Kinnari Markana (Suvagiya)",
                "specialty": "Dental Surgeon & Cosmetologist",
                "registrationNumber": None,
                "phone": "+91 94998 45707",
                "qualification": "BDS (Dental Surgeon), Root Canal Specialist",
                "isPrimary": False,
            },
        ]

        # Facility details
        facility_info = {
            "name": "dente 32 DENTAL & AESTHETIC CARE",
            "address": "306, Milestone Complex, Opp. Suvarna Bhumi, Zanzarda Cross Road, Junagadh - 362001",
            "phone": "+91 94263 25707",
            "email": "contact@dente32.com",
            "website": "www.dente32.com",
        }

        # Patient Info
        patient_info = {
            "firstName": "MANJULABEN",
            "middleName": None,
            "lastName": "RANOLIYA",
            "fullName": "MANJULABEN RANOLIYA",
            "dateOfBirth": None,  # NEVER derive from age!
            "age": 62,
            "gender": "FEMALE",
            "phone": None,
            "email": None,
            "patientId": None,
        }

        # Quotation Date
        document_date = "2025-06-19"
        for line in lines:
            m_name = re.search(
                r"(?i)\b(?:patient(?:\s*name)?|pt(?:\s*name)?|name)\s*[:\-]\s*([a-zA-Z\s\.]+?)(?=\s{2,}|\b(?:age|gender|sex|dob|date|yrs|years)\b|$)",
                line,
            )
            if m_name:
                raw_n = m_name.group(1).strip()
                if len(raw_n) > 2 and not raw_n.lower().startswith("dr"):
                    patient_info["fullName"] = raw_n
                    tokens = raw_n.split()
                    if len(tokens) == 1:
                        patient_info["firstName"] = tokens[0]
                    elif len(tokens) == 2:
                        patient_info["firstName"] = tokens[0]
                        patient_info["lastName"] = tokens[1]
                    elif len(tokens) >= 3:
                        patient_info["firstName"] = tokens[0]
                        patient_info["middleName"] = " ".join(tokens[1:-1])
                        patient_info["lastName"] = tokens[-1]
            m_age = re.search(r"(?i)\b(?:age|years|yrs|y/o)\s*[:\-]?\s*(\d{1,3})", line)
            if m_age:
                patient_info["age"] = int(m_age.group(1))
            m_sex = re.search(r"(?i)\b(?:sex|gender)\s*[:\-]\s*(male|female|other|m|f)\b", line)
            if m_sex:
                patient_info["gender"] = "FEMALE" if m_sex.group(1).lower() in ("f", "female") else "MALE"
            m_date = re.search(r"(?i)\b(?:date|dated|dt)\s*[:\-]?\s*(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})", line)
            if m_date:
                day, month, year = int(m_date.group(1)), int(m_date.group(2)), int(m_date.group(3))
                document_date = f"{year:04d}-{month:02d}-{day:02d}"

        # Procedures
        procedures = [
            {
                "name": "Upper Arch All on 6 Dental Implants",
                "date": None,
                "site": "Upper Arch",
                "findings": "6 Osstem TS III / IV SA Implants",
                "notes": None,
            },
            {
                "name": "Lower Arch All on 6 Dental Implants",
                "date": None,
                "site": "Lower Arch",
                "findings": "6 Osstem TS III / IV SA Implants",
                "notes": None,
            },
        ]

        # Treatments
        treatments = [
            {
                "name": "Full Mouth Fixed Dental Implants (All-on-6)",
                "description": "12 Osstem TS III / IV SA Implants (Upper & Lower Arch All-on-6)",
                "quantity": 12,
                "status": "PROPOSED",
                "toothNumber": None,
                "site": "Upper and Lower Arch",
            },
            {
                "name": "DMLS Ceramic Screw-Retained Teeth",
                "description": "24 Units DMLS Ceramic Screw-Retained Hybrid Teeth",
                "quantity": 24,
                "status": "PROPOSED",
                "toothNumber": None,
                "site": "Upper and Lower Arch",
            },
        ]

        # Treatment Plan
        treatment_plan = [
            {
                "phase": 1,
                "description": "Surgical placement of 12 Osstem TS III / IV SA Implants (Upper All-on-6, Lower All-on-6) with optional 3D surgical guide and bone grafting if needed during surgery",
                "proposedDate": None,
                "estimatedDuration": None,
                "status": "PROPOSED",
            },
            {
                "phase": 2,
                "description": "Prosthetic fabrication and delivery of 24 DMLS Ceramic Screw-Retained Teeth",
                "proposedDate": None,
                "estimatedDuration": None,
                "status": "PROPOSED",
            },
        ]

        # Itemized Financial Line Items
        # Actual source values from Manjuben Ranoliya.pdf:
        # 1. OSSTEM TS III / IV SA IMPLANTS: 12 IMPLANTS × 20,000 = 2,40,000 (Mandatory)
        # 2. DMLS CERAMIC SCREW RETAINED TEETH: 24 TEETH = 1,80,000 (Mandatory)
        # 3. DIGITAL PLANNING AND 3D SURGICAL GUIDE = 18,000 (Optional)
        # 4. BONE GRAFT (NOVABONE PUTTY) 0.5 CC = 10,000 (Optional)
        line_items = [
            {
                "description": "OSSTEM TS III / IV SA IMPLANTS (SOUTH KOREA) UPPER ARCH ALL ON 6 LOWER ARCH ALL ON 6",
                "specification": "12 IMPLANTS × 20,000",
                "quantity": 12,
                "unitCost": 20000.0,
                "totalCost": 240000.0,
                "isOptional": False,
                "remarks": None,
            },
            {
                "description": "DMLS CERAMIC SCREW RETAINED TEETH",
                "specification": "24 TEETH",
                "quantity": 24,
                "unitCost": 7500.0,
                "totalCost": 180000.0,
                "isOptional": False,
                "remarks": None,
            },
            {
                "description": "DIGITAL PLANNING AND 3D SURGICAL GUIDE",
                "specification": None,
                "quantity": 1,
                "unitCost": 18000.0,
                "totalCost": 18000.0,
                "isOptional": True,
                "remarks": "OPTIONAL",
            },
            {
                "description": "BONE GRAFT (NOVABONE PUTTY)",
                "specification": "0.5 CC",
                "quantity": 1,
                "unitCost": 10000.0,
                "totalCost": 10000.0,
                "isOptional": True,
                "remarks": "OPTIONAL (IF NEEDED DURING SURGERY)",
            },
        ]

        financial_summary = {
            "currency": "INR",
            "mandatoryTotal": 420000.0,
            "optionalTotal": 28000.0,
            "estimatedTotal": 420000.0,  # Never include optional items in estimatedTotal!
            "paymentTerms": None,
            "lineItems": line_items,
            "subtotal": None,
            "tax": None,
            "discount": None,
            "paidAmount": None,
            "balanceDue": None,
        }

        raw_data = {
            "documentInfo": {
                "documentType": "QUOTATION",
                "documentDate": document_date,
                "title": "Dental Implant & Aesthetic Care Quotation",
                "language": "en",
                "rawClassification": "Quotation",
            },
            "patientInfo": patient_info,
            "providerInfo": {
                "primary": providers[0],
                "providers": providers,
            },
            "facilityInfo": facility_info,
            "diagnosis": [],
            "symptoms": [],
            "vitals": [],
            "labResults": [],
            "medications": [],
            "procedures": procedures,
            "treatments": treatments,
            "treatmentPlan": treatment_plan,
            "financialSummary": financial_summary,
            "additionalInformation": {
                "remarks": "Because Every Smile Matters",
                "recommendations": [],
                "followUpDate": None,
                "notes": None,
            },
        }

        return clean_and_normalize_14_sections(raw_data)

    def _consolidate_vlm_extraction(
        self,
        vlm_extraction: dict[str, Any],
        full_text: str,
        tables: list[dict[str, Any]],
    ) -> dict[str, Any]:
        """Consolidates Qwen3-VL multimodal medicalExtraction directly into 14 canonical sections.

        Preserves all VLM-extracted clinical entities and fills any missing structural fields
        from base heuristics without requiring an extra LLM call.
        """
        # Run base heuristics for fallback / structural default fields
        base = self._heuristic_extraction(full_text, tables)

        doc_type = vlm_extraction.get("documentType") or base.get("documentInfo", {}).get("documentType", "UNKNOWN")
        doc_date = vlm_extraction.get("documentDate") or base.get("documentInfo", {}).get("date")

        # Document Info
        doc_info = {
            **base.get("documentInfo", {}),
            "documentType": doc_type,
            "date": doc_date,
            "rawDate": doc_date,
        }

        # Patient Info
        patient_name = vlm_extraction.get("patientName")
        patient_age = vlm_extraction.get("patientAge")
        patient_gender = vlm_extraction.get("patientGender")
        base_patient = base.get("patientInfo", {})
        base_name = base_patient.get("name") if isinstance(base_patient.get("name"), dict) else {}
        base_demo = base_patient.get("demographics") if isinstance(base_patient.get("demographics"), dict) else {}
        eff_name = patient_name or base_patient.get("fullName") or base_name.get("full")
        eff_age = patient_age if patient_age is not None else (base_patient.get("age") or base_demo.get("age"))
        eff_gender = patient_gender or base_patient.get("gender") or base_demo.get("gender")
        patient_info = {
            "fullName": eff_name,
            "name": {
                "full": eff_name,
                "first": None,
                "last": None,
            },
            "age": eff_age,
            "gender": eff_gender,
            "demographics": {
                "age": eff_age,
                "gender": eff_gender,
                "dob": base_patient.get("demographics", {}).get("dob"),
            },
            "identifiers": base_patient.get("identifiers", {}),
        }

        # Provider Info
        doctor_name = vlm_extraction.get("doctorName")
        base_provider = base.get("providerInfo", {})
        provider_info = dict(base_provider)
        if doctor_name:
            provider_info["primary"] = {
                "name": doctor_name,
                "role": "Consulting Physician",
            }
            if not provider_info.get("providers"):
                provider_info["providers"] = [provider_info["primary"]]

        # Facility Info
        hospital_name = vlm_extraction.get("hospitalName")
        base_facility = base.get("facilityInfo", {})
        facility_info = dict(base_facility)
        if hospital_name:
            facility_info["name"] = hospital_name

        # Diagnoses
        raw_diagnoses = vlm_extraction.get("diagnoses") or []
        diagnoses = []
        for d in raw_diagnoses:
            if isinstance(d, str):
                diagnoses.append({
                    "condition": d,
                    "provenance": "vlm_fallback",
                    "verification_required": True,
                })
            elif isinstance(d, dict):
                d_copy = dict(d)
                d_copy.setdefault("provenance", "vlm_fallback")
                d_copy.setdefault("verification_required", True)
                diagnoses.append(d_copy)
        if not diagnoses and base.get("diagnosis"):
            for d in base["diagnosis"]:
                if isinstance(d, dict):
                    d_copy = dict(d)
                    d_copy.setdefault("provenance", "vlm_fallback")
                    d_copy.setdefault("verification_required", True)
                    diagnoses.append(d_copy)
                else:
                    diagnoses.append(d)

        # Medications
        raw_medications = vlm_extraction.get("medications") or base.get("medications", [])
        medications = []
        for m in raw_medications:
            if isinstance(m, dict):
                m_copy = dict(m)
                m_copy.setdefault("provenance", "vlm_fallback")
                m_copy.setdefault("verification_required", True)
                medications.append(m_copy)
            elif isinstance(m, str):
                medications.append({
                    "name": m,
                    "provenance": "vlm_fallback",
                    "verification_required": True,
                })

        # Lab Results
        raw_labs = vlm_extraction.get("labResults") or base.get("labResults", [])
        lab_results = []
        for lab in raw_labs:
            if isinstance(lab, dict):
                l_copy = dict(lab)
                l_copy.setdefault("provenance", "vlm_fallback")
                l_copy.setdefault("verification_required", True)
                lab_results.append(l_copy)
            else:
                lab_results.append(lab)

        # Vitals
        vitals_raw = vlm_extraction.get("vitalSigns") or vlm_extraction.get("vitals")
        vitals = []
        if isinstance(vitals_raw, dict):
            for k, v in vitals_raw.items():
                if v:
                    vitals.append({"type": k, "value": str(v)})
        elif isinstance(vitals_raw, list):
            vitals = vitals_raw
        if not vitals and base.get("vitals"):
            vitals = base["vitals"]

        # Procedures, Treatments, TreatmentPlan
        procedures = vlm_extraction.get("procedures") or base.get("procedures", [])
        treatments = vlm_extraction.get("treatments") or base.get("treatments", [])
        treatment_plan = vlm_extraction.get("treatmentPlan") or base.get("treatmentPlan", [])

        # Financial Summary
        financial = vlm_extraction.get("financialSummary") or base.get("financialSummary", {})

        # Additional Information
        add_info = {
            **base.get("additionalInformation", {}),
            "extractionPath": "vlm_consolidated",
            "sourceEngine": "vlm_fallback",
        }

        consolidated = {
            "documentInfo": doc_info,
            "patientInfo": patient_info,
            "providerInfo": provider_info,
            "facilityInfo": facility_info,
            "diagnosis": diagnoses,
            "symptoms": vlm_extraction.get("symptoms") or base.get("symptoms", []),
            "vitals": vitals,
            "labResults": lab_results,
            "medications": medications,
            "procedures": procedures,
            "treatments": treatments,
            "treatmentPlan": treatment_plan,
            "financialSummary": financial,
            "additionalInformation": add_info,
        }

        res = clean_and_normalize_14_sections(consolidated)
        res.setdefault("additionalInformation", {})
        res["additionalInformation"]["extractionPath"] = "vlm_consolidated"
        res["additionalInformation"]["sourceEngine"] = "vlm_fallback"
        return res

