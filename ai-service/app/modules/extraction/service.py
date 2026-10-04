from __future__ import annotations

import re
from typing import Any

from app.core.json_utils import parse_json_object
from app.modules.extraction.prompts import graph_extraction_prompt, structured_document_prompt, summary_prompt
from app.services.llm import LLMService
from app.services.llm.service import LLMModelError

_PLACEHOLDER_REGEX = re.compile(
    r"^(string\|null|number\|null|null|undefined|string|number|boolean|object|\[.*\])$",
    re.IGNORECASE,
)


def _sanitize_string(val: Any) -> str | None:
    if val is None:
        return None
    if not isinstance(val, str):
        val = str(val)
    trimmed = val.strip()
    if not trimmed or _PLACEHOLDER_REGEX.match(trimmed) or "|null" in trimmed.lower():
        return None
    return trimmed


def _sanitize_page(val: Any) -> int | None:
    if val is None:
        return None
    if isinstance(val, int) and not isinstance(val, bool):
        return val
    if isinstance(val, float) and val.is_integer():
        return int(val)
    if isinstance(val, str):
        trimmed = val.strip()
        if _PLACEHOLDER_REGEX.match(trimmed) or "|null" in trimmed.lower():
            return None
        if re.fullmatch(r"-?\d+", trimmed):
            return int(trimmed)
    return None


def _sanitize_graph_type(val: Any) -> str:
    if not val:
        return "unknown"
    val_str = str(val).strip().lower()
    if "|" in val_str or _PLACEHOLDER_REGEX.match(val_str) or len(val_str) > 64:
        return "unknown"
    return val_str


def _sanitize_axis(val: Any) -> list:
    if not isinstance(val, list):
        return []
    cleaned = []
    for item in val:
        if isinstance(item, str):
            trimmed = item.strip()
            if _PLACEHOLDER_REGEX.match(trimmed) or "..." in trimmed or "|null" in trimmed.lower():
                continue
            cleaned.append(trimmed)
        elif isinstance(item, (int, float)) and not isinstance(item, bool):
            cleaned.append(item)
    return cleaned


def _sanitize_series(val: Any) -> list:
    if not isinstance(val, list):
        return []
    cleaned = []
    for item in val:
        if not isinstance(item, dict):
            continue
        name = _sanitize_string(item.get("name")) or "Series"
        values = _sanitize_axis(item.get("values"))
        cleaned.append({"name": name, "values": values})
    return cleaned


def _sanitize_int(val: Any) -> int | None:
    if val is None:
        return None
    if isinstance(val, int) and not isinstance(val, bool):
        return val
    if isinstance(val, float) and val.is_integer():
        return int(val)
    if isinstance(val, str):
        trimmed = val.strip()
        if _PLACEHOLDER_REGEX.match(trimmed) or "|null" in trimmed.lower():
            return None
        m = re.search(r"\b(\d{1,3})\b", trimmed)
        if m:
            return int(m.group(1))
    return None


def _sanitize_float(val: Any) -> float | None:
    if val is None:
        return None
    if isinstance(val, (int, float)) and not isinstance(val, bool):
        return float(val)
    if isinstance(val, str):
        trimmed = val.strip()
        if _PLACEHOLDER_REGEX.match(trimmed) or "|null" in trimmed.lower():
            return None
        cleaned = re.sub(r"[₹\$,/\\s\-]|(?i)rs\.?|(?i)/-", "", trimmed).replace(",", "").strip()
        try:
            return float(cleaned)
        except ValueError:
            return None
    return None


def _sanitize_iso_date(val: Any) -> str | None:
    if not val or not isinstance(val, str):
        return None
    trimmed = val.strip()
    if _PLACEHOLDER_REGEX.match(trimmed) or "|null" in trimmed.lower():
        return None
    # Check YYYY-MM-DD
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", trimmed):
        return trimmed
    # Check DD/MM/YYYY or DD-MM-YYYY
    m_dmy = re.fullmatch(r"(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})", trimmed)
    if m_dmy:
        day, month, year = int(m_dmy.group(1)), int(m_dmy.group(2)), int(m_dmy.group(3))
        if 1 <= month <= 12 and 1 <= day <= 31:
            return f"{year:04d}-{month:02d}-{day:02d}"
    # Check MM/DD/YYYY if plausible
    return None


def _normalize_patient_info(raw: dict) -> dict:
    if not isinstance(raw, dict):
        raw = {}
    raw_name = raw.get("name")
    if isinstance(raw_name, dict):
        raw_name_str = raw_name.get("full") or raw_name.get("first")
    else:
        raw_name_str = raw_name
    full_name = _sanitize_string(raw.get("fullName") or raw_name_str)
    first_name = _sanitize_string(raw.get("firstName"))
    middle_name = _sanitize_string(raw.get("middleName"))
    last_name = _sanitize_string(raw.get("lastName"))

    # Decompose full name only if components were not explicitly supplied
    if full_name and not (first_name or last_name):
        tokens = full_name.split()
        if len(tokens) == 1:
            first_name = tokens[0]
        elif len(tokens) == 2:
            first_name = tokens[0]
            last_name = tokens[1]
        elif len(tokens) >= 3:
            first_name = tokens[0]
            middle_name = " ".join(tokens[1:-1])
            last_name = tokens[-1]

    raw_gender = str(raw.get("gender") or "").upper().strip()
    if raw_gender in ("M", "MALE", "BOY"):
        gender = "MALE"
    elif raw_gender in ("F", "FEMALE", "GIRL", "WOMAN"):
        gender = "FEMALE"
    elif raw_gender in ("OTHER", "TRANSGENDER"):
        gender = "OTHER"
    else:
        gender = None

    return {
        "name": full_name,
        "firstName": first_name,
        "middleName": middle_name,
        "lastName": last_name,
        "fullName": full_name,
        "dateOfBirth": _sanitize_iso_date(raw.get("dateOfBirth") or raw.get("dob")),
        "age": _sanitize_int(raw.get("age")),
        "gender": gender,
        "phone": _sanitize_string(raw.get("phone") or raw.get("phoneNumber")),
        "email": _sanitize_string(raw.get("email")),
        "patientId": _sanitize_string(raw.get("patientId") or raw.get("uhid") or raw.get("id")),
    }


def _normalize_provider_info(raw: dict, legacy_doctor: dict | None = None) -> dict:
    if not isinstance(raw, dict):
        raw = {}
    providers_list = raw.get("providers") if isinstance(raw.get("providers"), list) else []
    raw_primary = raw.get("primary") if isinstance(raw.get("primary"), dict) else None

    # Merge legacy doctorInfo if present
    if not providers_list and legacy_doctor and isinstance(legacy_doctor, dict):
        doc_name = _sanitize_string(legacy_doctor.get("name"))
        if doc_name:
            providers_list.append({
                "name": doc_name,
                "specialty": _sanitize_string(legacy_doctor.get("specialty")),
                "registrationNumber": _sanitize_string(legacy_doctor.get("registrationNumber")),
                "phone": _sanitize_string(legacy_doctor.get("phone")),
                "qualification": _sanitize_string(legacy_doctor.get("qualification")),
                "isPrimary": True,
            })

    cleaned_providers: list[dict] = []
    for item in providers_list:
        if isinstance(item, str):
            cleaned_providers.append({
                "name": _sanitize_string(item),
                "specialty": None,
                "registrationNumber": None,
                "phone": None,
                "qualification": None,
                "isPrimary": False,
            })
        elif isinstance(item, dict):
            cleaned_providers.append({
                "name": _sanitize_string(item.get("name")),
                "specialty": _sanitize_string(item.get("specialty")),
                "registrationNumber": _sanitize_string(item.get("registrationNumber")),
                "phone": _sanitize_string(item.get("phone")),
                "qualification": _sanitize_string(item.get("qualification")),
                "isPrimary": bool(item.get("isPrimary")),
            })

    # Deduce primary provider
    primary_provider: dict | None = None
    if raw_primary:
        primary_provider = {
            "name": _sanitize_string(raw_primary.get("name")),
            "specialty": _sanitize_string(raw_primary.get("specialty")),
            "registrationNumber": _sanitize_string(raw_primary.get("registrationNumber")),
            "phone": _sanitize_string(raw_primary.get("phone")),
            "qualification": _sanitize_string(raw_primary.get("qualification")),
            "isPrimary": True,
        }
    else:
        primaries = [p for p in cleaned_providers if p.get("isPrimary")]
        if len(primaries) == 1:
            primary_provider = primaries[0]
        elif len(cleaned_providers) == 1:
            cleaned_providers[0]["isPrimary"] = True
            primary_provider = cleaned_providers[0]
        else:
            # If multiple and none marked primary, remain None (never arbitrarily select)
            primary_provider = None

    return {
        "primary": primary_provider,
        "providers": cleaned_providers,
    }


def _normalize_facility_info(raw: dict, legacy_hospital: dict | None = None) -> dict:
    if not isinstance(raw, dict):
        raw = {}
    leg = legacy_hospital if isinstance(legacy_hospital, dict) else {}
    return {
        "name": _sanitize_string(raw.get("name") or leg.get("name")),
        "address": _sanitize_string(raw.get("address") or leg.get("address")),
        "phone": _sanitize_string(raw.get("phone") or leg.get("phone")),
        "email": _sanitize_string(raw.get("email") or leg.get("email")),
        "website": _sanitize_string(raw.get("website") or leg.get("website")),
    }


def _normalize_financial_summary(raw: dict, doc_type: str = "", document_type: str = "") -> dict:
    if not isinstance(raw, dict):
        raw = {}
    effective_doc_type = doc_type or document_type
    currency = _sanitize_string(raw.get("currency")) or "INR"
    raw_lines = raw.get("lineItems") if isinstance(raw.get("lineItems"), list) else []

    cleaned_lines: list[dict] = []
    for item in raw_lines:
        if not isinstance(item, dict):
            continue
        desc = _sanitize_string(item.get("description") or item.get("details"))
        if not desc:
            continue
        spec = _sanitize_string(item.get("specification"))
        qty = _sanitize_float(item.get("quantity")) or 1.0
        unit_cost = _sanitize_float(item.get("unitCost") or item.get("rate") or item.get("unitPrice") or item.get("price"))
        total_cost = _sanitize_float(
            item.get("totalCost") or item.get("totalPrice") or item.get("estimatedQuotation") or item.get("amount") or item.get("cost")
        )
        if total_cost is None and unit_cost is not None and qty:
            total_cost = round(unit_cost * qty, 2)
        remarks = _sanitize_string(item.get("remarks"))
        is_optional = bool(item.get("isOptional")) or bool(
            remarks and "optional" in remarks.lower()
        )

        cleaned_lines.append({
            "description": desc,
            "specification": spec,
            "quantity": qty,
            "unitCost": unit_cost,
            "totalCost": total_cost,
            "isOptional": is_optional,
            "remarks": remarks,
        })

    is_quotation = "QUOTATION" in effective_doc_type.upper()
    mandatory_calc = sum(
        item["totalCost"] for item in cleaned_lines if not item["isOptional"] and item["totalCost"] is not None
    )
    optional_calc = sum(
        item["totalCost"] for item in cleaned_lines if item["isOptional"] and item["totalCost"] is not None
    )

    if is_quotation:
        raw_mand = _sanitize_float(raw.get("mandatoryTotal"))
        raw_opt = _sanitize_float(raw.get("optionalTotal"))
        raw_est = _sanitize_float(raw.get("estimatedTotal"))

        mandatory_total = raw_mand if raw_mand is not None else (mandatory_calc if mandatory_calc > 0 else None)
        optional_total = raw_opt if raw_opt is not None else (optional_calc if optional_calc > 0 else 0.0 if cleaned_lines else None)
        # Estimated total must equal mandatory total; NEVER add optional items!
        estimated_total = mandatory_total
    else:
        mandatory_total = _sanitize_float(raw.get("mandatoryTotal") or raw.get("total") or raw.get("totalAmount")) or (mandatory_calc if mandatory_calc > 0 else None)
        optional_total = _sanitize_float(raw.get("optionalTotal")) or (optional_calc if optional_calc > 0 else None)
        estimated_total = _sanitize_float(raw.get("estimatedTotal")) or mandatory_total

    return {
        "currency": currency,
        "mandatoryTotal": mandatory_total,
        "optionalTotal": optional_total,
        "estimatedTotal": estimated_total,
        "totalAmount": mandatory_total,
        "paymentTerms": _sanitize_string(raw.get("paymentTerms")),
        "lineItems": cleaned_lines,
        "subtotal": _sanitize_float(raw.get("subtotal")),
        "tax": _sanitize_float(raw.get("tax")),
        "discount": _sanitize_float(raw.get("discount")),
        "paidAmount": _sanitize_float(raw.get("paidAmount")),
        "balanceDue": _sanitize_float(raw.get("balanceDue") or raw.get("dueAmount")),
    }


def clean_and_normalize_14_sections(data: dict, structured_ocr: dict | None = None) -> dict:
    if not isinstance(data, dict):
        data = {}

    doc_info_raw = data.get("documentInfo") if isinstance(data.get("documentInfo"), dict) else {}
    doc_type = _sanitize_string(
        doc_info_raw.get("documentType") or data.get("documentType") or data.get("reportType")
    ) or "UNKNOWN"

    # Normalize documentInfo
    document_info = {
        "documentType": doc_type.upper(),
        "documentDate": _sanitize_iso_date(doc_info_raw.get("documentDate") or data.get("reportDate") or data.get("date")),
        "title": _sanitize_string(doc_info_raw.get("title") or data.get("title")),
        "language": _sanitize_string(doc_info_raw.get("language")) or "en",
        "rawClassification": _sanitize_string(doc_info_raw.get("rawClassification")),
    }

    # Normalize patientInfo
    patient_info = _normalize_patient_info(
        data.get("patientInfo") if isinstance(data.get("patientInfo"), dict) else {}
    )

    # Normalize providerInfo (with fallback to legacy doctorInfo)
    provider_info = _normalize_provider_info(
        data.get("providerInfo") if isinstance(data.get("providerInfo"), dict) else {},
        legacy_doctor=data.get("doctorInfo") if isinstance(data.get("doctorInfo"), dict) else None,
    )

    # Normalize facilityInfo (with fallback to legacy hospitalInfo)
    facility_info = _normalize_facility_info(
        data.get("facilityInfo") if isinstance(data.get("facilityInfo"), dict) else {},
        legacy_hospital=data.get("hospitalInfo") if isinstance(data.get("hospitalInfo"), dict) else None,
    )

    # Normalize lists
    diagnosis = data.get("diagnosis") if isinstance(data.get("diagnosis"), list) else []
    symptoms = data.get("symptoms") if isinstance(data.get("symptoms"), list) else []
    vitals = data.get("vitals") if isinstance(data.get("vitals"), list) else []
    lab_results = data.get("labResults") if isinstance(data.get("labResults"), list) else []
    medications = data.get("medications") if isinstance(data.get("medications"), list) else []
    procedures = data.get("procedures") if isinstance(data.get("procedures"), list) else []
    treatments = data.get("treatments") if isinstance(data.get("treatments"), list) else []
    treatment_plan = data.get("treatmentPlan") if isinstance(data.get("treatmentPlan"), list) else []

    # Normalize financialSummary
    financial_summary = _normalize_financial_summary(
        data.get("financialSummary") if isinstance(data.get("financialSummary"), dict) else {},
        doc_type=document_info["documentType"],
    )

    # Normalize additionalInformation
    add_info_raw = data.get("additionalInformation") if isinstance(data.get("additionalInformation"), dict) else {}
    additional_info = {
        "remarks": _sanitize_string(add_info_raw.get("remarks") or data.get("remarks")),
        "recommendations": add_info_raw.get("recommendations") if isinstance(add_info_raw.get("recommendations"), list) else (
            data.get("recommendations") if isinstance(data.get("recommendations"), list) else []
        ),
        "followUpDate": _sanitize_iso_date(add_info_raw.get("followUpDate")),
        "notes": _sanitize_string(add_info_raw.get("notes")),
    }
    for k, v in add_info_raw.items():
        if k not in additional_info:
            additional_info[k] = v

    # If document is quotation, strictly enforce empty clinical lists
    if "QUOTATION" in document_info["documentType"]:
        diagnosis = []
        medications = []
        lab_results = []
        vitals = []

    res = {
        "documentInfo": document_info,
        "patientInfo": patient_info,
        "providerInfo": provider_info,
        "facilityInfo": facility_info,
        "diagnosis": diagnosis,
        "symptoms": symptoms,
        "vitals": vitals,
        "labResults": lab_results,
        "medications": medications,
        "procedures": procedures,
        "treatments": treatments,
        "treatmentPlan": treatment_plan,
        "financialSummary": financial_summary,
        "additionalInformation": additional_info,
    }

    if structured_ocr and isinstance(structured_ocr, dict):
        res["paragraphs"] = structured_ocr.get("paragraphs", [])
        res["fullText"] = structured_ocr.get("fullText", "")

    return res


def normalize_graph_dict(graph: dict) -> dict:
    return {
        "graphType": _sanitize_graph_type(graph.get("graphType")),
        "title": _sanitize_string(graph.get("title")),
        "xAxis": _sanitize_axis(graph.get("xAxis")),
        "yAxis": _sanitize_axis(graph.get("yAxis")),
        "series": _sanitize_series(graph.get("series")),
        "unit": _sanitize_string(graph.get("unit")),
        "page": _sanitize_page(graph.get("page")),
        "metadata": graph.get("metadata") if isinstance(graph.get("metadata"), dict) else {},
    }


def parse_json(text: str, _unused_default: dict | None = None) -> dict:
    try:
        parsed = parse_json_object(text)
        return parsed if isinstance(parsed, dict) else {}
    except Exception as exc:
        raise LLMModelError(f"Configured AI model returned invalid extraction JSON: {exc}") from exc


def parse_json_loose(text: str) -> list | dict | None:
    if not text or not text.strip():
        return None
    try:
        parsed = parse_json_object(text)
        return parsed if isinstance(parsed, (list, dict)) else None
    except Exception as exc:
        raise LLMModelError(f"Configured AI model returned invalid graph JSON: {exc}") from exc


class ExtractionService:
    def __init__(self, llm: LLMService, vision_model: str, chat_model: str, num_predict: int = 1024) -> None:
        self.llm = llm
        self.vision_model = vision_model
        self.chat_model = chat_model
        self.num_predict = num_predict

    async def normalize_structured_ocr(self, structured_ocr: dict) -> dict:
        content = await self.llm.chat(
            model=self.chat_model or self.vision_model,
            messages=structured_document_prompt(structured_ocr),
            temperature=0.0,
            format_json=True,
            num_predict=min(self.num_predict, 1024),
        )
        parsed = parse_json(content, {})
        return clean_and_normalize_14_sections(parsed, structured_ocr)

    async def summarize(self, structured_document: dict, patient_context: dict | None, medications: list[dict], entities: list[dict]) -> dict:
        content = await self.llm.chat(
            model=self.chat_model,
            messages=summary_prompt(structured_document, patient_context, medications, entities),
            temperature=0.1,
            format_json=True,
            num_predict=self.num_predict,
        )
        return parse_json(
            content,
            {
                "title": "Medical document summary",
                "documentType": "unknown",
                "summary": structured_document.get("fullText", "")[:800],
                "keyFindings": [],
                "abnormalResults": [],
                "medications": [],
                "allergies": [],
                "followUps": [],
                "patientSafetyNotes": [],
                "citations": [],
            },
        )

    async def extract_graphs(self, structured_document: dict) -> list[dict]:
        """Detect chart/graph data in the document and return normalized JSON.

        We deliberately keep this on the model path because text extraction
        does not provide reliable chart-to-data extraction. The configured
        AI_MODEL receives the full structured OCR and emits graph objects.

        Returns an empty list when no graphs are detected — the response is
        always JSON-safe for the caller.
        """ 
        content = await self.llm.chat(
            model=self.chat_model,
            messages=graph_extraction_prompt(structured_document),
            temperature=0.0,
            format_json=True,
            num_predict=self.num_predict * 2,
        )
        parsed = parse_json_loose(content)
        if isinstance(parsed, dict):
            graphs = parsed.get("graphs") or []
        elif isinstance(parsed, list):
            graphs = parsed
        else:
            graphs = []

        normalized: list[dict] = []
        for graph in graphs:
            if not isinstance(graph, dict):
                continue
            normalized.append(normalize_graph_dict(graph))
        return normalized
