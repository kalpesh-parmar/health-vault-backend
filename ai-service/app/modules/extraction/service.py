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
    def __init__(self, llm: LLMService, vision_model: str, chat_model: str, num_predict: int = 220) -> None:
        self.llm = llm
        self.vision_model = vision_model
        self.chat_model = chat_model
        self.num_predict = num_predict

    async def normalize_structured_ocr(self, structured_ocr: dict) -> dict:
        content = await self.llm.chat(
            model=self.vision_model,
            messages=structured_document_prompt(structured_ocr),
            temperature=0.0,
            format_json=True,
            num_predict=self.num_predict,
        )
        normalized = parse_json(content, {})
        normalized.setdefault("patientInfo", {})
        normalized.setdefault("hospitalInfo", {})
        normalized.setdefault("doctorInfo", {})
        normalized.setdefault("diagnosis", [])
        normalized.setdefault("medications", [])
        normalized.setdefault("labResults", [])
        normalized.setdefault("vitals", [])
        normalized.setdefault("recommendations", [])
        normalized.setdefault("summary", "")
        normalized.setdefault("paragraphs", structured_ocr.get("paragraphs", []))
        normalized.setdefault("fullText", structured_ocr.get("fullText", ""))
        return normalized

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
