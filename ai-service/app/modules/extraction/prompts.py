from __future__ import annotations

import json
from typing import Any

from app.modules.ocr.cleanup import clean_ocr_text, compress_for_llm


def _format_tables(tables: list[Any]) -> str:
    if not tables:
        return ""
    rendered: list[str] = []
    for i, table in enumerate(tables):
        if not isinstance(table, dict):
            continue
        rows = table.get("rows") or table.get("cells") or []
        if isinstance(rows, list) and rows:
            table_lines = [f"Table {i+1}:"]
            for row in rows:
                if isinstance(row, list):
                    table_lines.append(" | ".join(str(c).strip() for c in row if str(c).strip()))
                elif isinstance(row, dict):
                    table_lines.append(" | ".join(f"{k}: {v}" for k, v in row.items() if str(v).strip()))
            rendered.append("\n".join(table_lines))
    return "\n\n".join(rendered)


def structured_document_prompt(structured_ocr: dict) -> list[dict]:
    full_text = structured_ocr.get("fullText") if isinstance(structured_ocr, dict) else ""
    if not full_text and isinstance(structured_ocr, dict) and "paragraphs" in structured_ocr:
        full_text = "\n".join(
            p.get("text", "") for p in structured_ocr.get("paragraphs", []) if isinstance(p, dict)
        )

    tables = structured_ocr.get("tables") if isinstance(structured_ocr, dict) else []
    tables_text = _format_tables(tables) if isinstance(tables, list) else ""

    if full_text:
        cleaned_text = clean_ocr_text(full_text)
        if not cleaned_text:
            cleaned_text = full_text.strip()
        if len(cleaned_text) > 48_000:
            cleaned_text = compress_for_llm(cleaned_text, max_chars=48_000)

        doc_content = cleaned_text
        if tables_text:
            doc_content += "\n\nExtracted Tables:\n" + tables_text
    else:
        doc_content = json.dumps(structured_ocr, ensure_ascii=False)
        if len(doc_content) > 48_000:
            doc_content = doc_content[:48_000]

    return [
        {
            "role": "system",
            "content": (
                "You are a deterministic medical document extraction engine. "
                "Return only valid JSON matching the 14-section healthcare schema. "
                "Do not diagnose, prescribe, or invent missing facts. "
                "Never derive date of birth from age. Genuinely absent sections must be empty arrays or null."
            ),
        },
        {
            "role": "user",
            "content": f"""Convert this OCR content into normalized JSON conforming to the 14-section schema:
{{
  "documentInfo": {{"documentType": "PRESCRIPTION", "language": "en"}},
  "patientInfo": {{"fullName": null, "age": null, "gender": null}},
  "providerInfo": {{"primary": {{"name": null, "specialty": null}}, "providers": []}},
  "facilityInfo": {{"name": null, "address": null}},
  "diagnosis": [],
  "symptoms": [],
  "vitals": [],
  "labResults": [{{"testName": "Test", "value": "10", "unit": "mg/dL"}}],
  "medications": [{{"name": "Drug", "dosage": "500mg", "frequency": "1-0-1"}}],
  "procedures": [],
  "treatments": [],
  "treatmentPlan": [],
  "financialSummary": {{"currency": "INR", "estimatedTotal": null}},
  "additionalInformation": {{"followUpDate": null, "remarks": null}}
}}

Rules:
1. Output all 14 top-level keys even if empty.
2. Patient Info: Preserve fullName verbatim. NEVER compute dateOfBirth from age.
3. Providers: Capture all identified doctors/clinicians.
4. Grounding: Do not invent facts. Use null for absent fields and [] for absent lists. Never output placeholder tokens.

Document Content:
{doc_content}
""",
        },
    ]


def summary_prompt(structured_document: dict, patient_context: dict | None, medications: list[dict], entities: list[dict]) -> list[dict]:
    return [
        {"role": "system", "content": "Return only JSON. Ground the summary only in the provided medical context."},
        {
            "role": "user",
            "content": f"""
Create a concise clinical document summary.
Schema:
{{
  "title": "",
  "documentType": "",
  "summary": "",
  "keyFindings": [],
  "abnormalResults": [],
  "medications": [],
  "allergies": [],
  "followUps": [],
  "patientSafetyNotes": [],
  "citations": []
}}

Patient: {json.dumps(patient_context, default=str)}
Known medications: {json.dumps(medications, default=str)}
Entities: {json.dumps(entities, default=str)}
Structured document: {json.dumps(structured_document, default=str, ensure_ascii=False)}
""",
        },
    ]



def graph_extraction_prompt(structured_document: dict) -> list[dict]:
    """Ask the LLM to emit normalized chart objects when the document
    contains BP / sugar / ECG / trend / line / bar charts.

    The LLM is told to return ``{"graphs": []}`` when no chart is present
    so callers can rely on the response always being JSON-safe.
    """
    return [
        {
            "role": "system",
            "content": (
                "You extract structured graph/chart data from medical documents. "
                "Return ONLY valid JSON. Never invent values that are not present "
                "in the source document. If no graphs are found, return "
                '{"graphs": []}.'
            ),
        },
        {
            "role": "user",
            "content": f"""
Inspect the medical document and extract every graph or chart you find
(BP trend, sugar trend, ECG, lab-value trend, bar chart, line chart, etc).

Required schema example:
{{
  "graphs": [
    {{
      "graphType": "trend",
      "title": "Blood Pressure Trend",
      "xAxis": ["2025-01-01", "2025-01-02"],
      "yAxis": [120, 118],
      "series": [{{"name": "Systolic", "values": [120, 118]}}],
      "unit": "mmHg",
      "page": 1,
      "metadata": {{}}
    }}
  ]
}}

Rules:
- graphType must be one of: "line-chart", "bar-chart", "ecg", "trend", "other".
- Only emit a graph if axis labels and at least two data points are recoverable from the source.
- Preserve the units shown in the document (mg/dL, mmHg, bpm, etc.).
- Use an integer for the page number if known, or null if unknown. Never output type names or union strings.
- If a string field (like title or unit) is unknown, set it to null. Never output placeholder tokens or type names.
- If the document only contains tables of values without an actual graph rendering, still emit a "trend" graph object IF the table is clearly a time series (date + value).
- If no graphs are found, return {{"graphs": []}}.

Document JSON:
{json.dumps(structured_document, default=str, ensure_ascii=False)}
""",
        },
    ]
