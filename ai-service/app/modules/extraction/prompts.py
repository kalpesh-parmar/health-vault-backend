from __future__ import annotations

import json


def structured_document_prompt(structured_ocr: dict) -> list[dict]:
    return [
        {
            "role": "system",
            "content": (
                "You are a deterministic medical document extraction engine. "
                "Return only valid JSON. Do not diagnose, prescribe, or invent missing facts."
            ),
        },
        {
            "role": "user",
            "content": f"""
Convert this OCR/layout JSON into normalized healthcare JSON.

Required schema:
{{
  "patientInfo": {{}},
  "hospitalInfo": {{}},
  "doctorInfo": {{}},
  "diagnosis": [],
  "medications": [],
  "labResults": [],
  "vitals": [],
  "recommendations": [],
  "summary": "",
  "language": string|null,
  "pageCount": number,
  "sections": [],
  "paragraphs": [],
  "tables": [],
  "forms": [],
  "prescriptions": [
    {{
      "doctorName": string|null,
      "pharmacyName": string|null,
      "issueDate": string|null,
      "refillInstructions": string|null,
      "medications": []
    }}
  ],
  "labReports": [],
  "medicalEntities": [
    {{
      "type": "medicine|dosage|blood_group|allergy|disease|test_value|abnormal_value|doctor_name|date|follow_up_instruction|other",
      "name": string,
      "value": string|null,
      "unit": string|null,
      "normalRange": string|null,
      "isAbnormal": boolean,
      "confidence": number,
      "sourceText": string|null,
      "metadata": {{}}
    }}
  ],
  "confidence": number,
  "fullText": string
}}

Rules:
- Keep the top-level patientInfo, hospitalInfo, doctorInfo, diagnosis,
  medications, labResults, vitals, recommendations, and summary keys even
  when values are empty.
- Do not invent missing medical facts. Empty objects and arrays are valid.
- Preserve values, units, ranges, dates, and abnormal flags exactly when present.

OCR JSON:
{json.dumps(structured_ocr, ensure_ascii=False)}
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
  "title": string,
  "documentType": string,
  "summary": string,
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

Required schema:
{{
  "graphs": [
    {{
      "graphType": "line-chart|bar-chart|ecg|trend|other",
      "title": string|null,
      "xAxis": [string|number, ...],
      "yAxis": [number, ...],
      "series": [{{"name": string, "values": [number, ...]}}],
      "unit": string|null,
      "page": number|null,
      "metadata": object
    }}
  ]
}}

Rules:
- Only emit a graph if axis labels and at least two data points are
  recoverable from the source.
- Preserve the units shown in the document (mg/dL, mmHg, bpm, etc.).
- Use the page number from the document if available.
- If the document only contains tables of values without an actual graph
  rendering, still emit a "trend" graph object IF the table is clearly a
  time series (date + value).

Document JSON:
{json.dumps(structured_document, default=str, ensure_ascii=False)}
""",
        },
    ]
