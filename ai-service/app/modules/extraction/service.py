from __future__ import annotations

from app.core.json_utils import parse_json_object
from app.modules.extraction.prompts import graph_extraction_prompt, structured_document_prompt, summary_prompt
from app.services.llm import LLMService
from app.services.llm.service import LLMModelError


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
            normalized.append(
                {
                    "graphType": str(graph.get("graphType") or "unknown").lower(),
                    "title": graph.get("title"),
                    "xAxis": graph.get("xAxis") or [],
                    "yAxis": graph.get("yAxis") or [],
                    "series": graph.get("series") or [],
                    "unit": graph.get("unit"),
                    "page": graph.get("page"),
                    "metadata": graph.get("metadata") or {},
                }
            )
        return normalized
