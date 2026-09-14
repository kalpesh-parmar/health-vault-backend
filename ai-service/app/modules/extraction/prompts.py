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

Required schema example:
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
  "language": null,
  "pageCount": 1,
  "sections": [],
  "paragraphs": [],
  "tables": [],
  "forms": [],
  "prescriptions": [
    {{
      "doctorName": null,
      "pharmacyName": null,
      "issueDate": null,
      "refillInstructions": null,
      "medications": [],
      "prescribedBy": null,
      "timing": null
    }}
  ],
  "labReports": [],
  "medicalEntities": [
    {{
      "type": "medicine",
      "name": "Paracetamol",
      "value": "500",
      "unit": "mg",
      "normalRange": null,
      "isAbnormal": false,
      "confidence": 0.95,
      "sourceText": null,
      "metadata": {{}}
    }}
  ],
  "confidence": 0.95,
  "fullText": ""
}}

Rules:
- Keep the top-level patientInfo, hospitalInfo, doctorInfo, diagnosis,
  medications, labResults, vitals, recommendations, and summary keys even
  when values are empty.
- Do not invent missing medical facts. Empty objects and arrays are valid.
- Preserve values, units, ranges, dates, and abnormal flags exactly when present.
- Use null for unknown or absent optional values. Never output placeholder tokens or type names.

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
