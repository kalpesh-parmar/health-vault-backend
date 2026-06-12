from __future__ import annotations

import asyncio
import json
import logging
import re

from app.modules.ocr.cleanup import clean_ocr_text, compress_for_llm
from app.services.llm import LLMService
from app.services.llm.service import LLMModelError

logger = logging.getLogger(__name__)


class SummaryService:
    def __init__(
        self,
        llm: LLMService,
        *,
        model: str,
        chunk_chars: int,
        max_chunks: int,
        num_predict: int,
    ) -> None:
        self.llm = llm
        self.model = model
        self.chunk_chars = chunk_chars
        self.max_chunks = max_chunks
        self.num_predict = num_predict

    async def summarize(self, text: str, *, mode: str = "concise", document_type: str = "medical") -> dict:
        compact = compress_for_llm(text, max_chars=self.chunk_chars * self.max_chunks)
        chunks = split_text(compact, max_chars=self.chunk_chars)[: self.max_chunks]
        if not chunks:
            return empty_summary(mode=mode, document_type=document_type)

        results = await asyncio.gather(
            *[
                self._summarize_chunk(chunk, mode=mode, document_type=document_type)
                for chunk in chunks
            ],
            return_exceptions=True,
        )

        partials: list[dict] = []
        errors: list[str] = []
        for result in results:
            if isinstance(result, Exception):
                errors.append(str(result))
                logger.warning(
                    "summary_chunk_failed_using_text_fallback",
                    extra={"model": self.model, "error": str(result)[:300]},
                )
                continue
            partials.append(result)

        if not partials:
            fallback = fallback_summary_from_text(compact, mode=mode, document_type=document_type)
            fallback.update(
                {
                    "chunks": len(chunks),
                    "inputChars": len(text),
                    "compressedChars": len(compact),
                    "summarySource": "text_fallback",
                    "summaryErrors": errors[:3],
                }
            )
            return fallback

        if len(partials) == 1:
            return partials[0] | {
                "chunks": 1,
                "inputChars": len(text),
                "compressedChars": len(compact),
                "summarySource": "llm_partial" if errors else "llm",
                "summaryErrors": errors[:3],
            }

        merged_text = "\n".join(json.dumps(partial, ensure_ascii=False) for partial in partials)
        try:
            final = await self._summarize_chunk(merged_text, mode=mode, document_type=document_type, merge=True)
            source = "llm_partial" if errors else "llm"
        except Exception as exc:
            logger.warning(
                "summary_merge_failed_using_partial_summary",
                extra={"model": self.model, "error": str(exc)[:300]},
            )
            final = merge_partial_summaries(partials, mode=mode, document_type=document_type)
            errors.append(str(exc))
            source = "partial_merge_fallback"

        return final | {
            "chunks": len(partials),
            "inputChars": len(text),
            "compressedChars": len(compact),
            "summarySource": source,
            "summaryErrors": errors[:3],
        }

    async def _summarize_chunk(self, text: str, *, mode: str, document_type: str, merge: bool = False) -> dict:
        prompt = build_prompt(text, mode=mode, document_type=document_type, merge=merge)
        raw = await self.llm.chat(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
            temperature=0.0,
            format_json=True,
            num_predict=self.num_predict if mode == "concise" else self.num_predict * 2,
        )
        return parse_summary(raw, mode=mode, document_type=document_type)


def build_prompt(text: str, *, mode: str, document_type: str, merge: bool) -> str:
    style = "brief" if mode == "concise" else "detailed"
    action = "Merge these partial summaries" if merge else "Summarize this medical document"
    return (
        f"{action}. Return JSON only: "
        '{"type":"","summary":[],"medications":[],"tests":[],"warnings":[],"follow_up":[]}. '
        f"Style:{style}. Doc:{document_type}. Text:\n{text}"
    )


def parse_summary(raw: str, *, mode: str, document_type: str) -> dict:
    cleaned = (raw or "").replace("```json", "").replace("```", "").strip()
    try:
        parsed = json.loads(cleaned)
        if isinstance(parsed, dict):
            return {
                "type": parsed.get("type") or document_type,
                "mode": mode,
                "summary": as_list(parsed.get("summary")),
                "medications": as_list(parsed.get("medications")),
                "tests": as_list(parsed.get("tests")),
                "warnings": as_list(parsed.get("warnings")),
                "follow_up": as_list(parsed.get("follow_up")),
            }
    except json.JSONDecodeError:
        raise LLMModelError("Configured AI model returned invalid summary JSON")

    raise LLMModelError("Configured AI model returned summary JSON in an unexpected shape")


def split_text(text: str, *, max_chars: int) -> list[str]:
    cleaned = clean_ocr_text(text)
    if len(cleaned) <= max_chars:
        return [cleaned] if cleaned else []
    chunks: list[str] = []
    current: list[str] = []
    current_tokens = 0
    max_tokens = max(128, max_chars // 4)
    for line in cleaned.splitlines():
        line_tokens = estimate_tokens(line)
        if current and current_tokens + line_tokens > max_tokens:
            chunks.append("\n".join(current))
            current = []
            current_tokens = 0
        current.append(line)
        current_tokens += line_tokens
    if current:
        chunks.append("\n".join(current))
    return chunks


def estimate_tokens(text: str) -> int:
    # Approximate tokenizer-independent count while preserving medical values,
    # dosages, dates, and lab ranges as indivisible-ish units.
    return max(1, len(re.findall(r"\w+(?:[./:-]\w+)*|[^\w\s]", text or "")))


def as_list(value) -> list:
    if value is None:
        return []
    if isinstance(value, list):
        return [normalize_item(item) for item in value if normalize_item(item)]
    normalized = normalize_item(value)
    return [normalized] if normalized else []


def normalize_item(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def empty_summary(*, mode: str, document_type: str) -> dict:
    return {"type": document_type, "mode": mode, "summary": [], "medications": [], "tests": [], "warnings": [], "follow_up": []}


def fallback_summary_from_text(text: str, *, mode: str, document_type: str) -> dict:
    cleaned = clean_ocr_text(text)
    summary = empty_summary(mode=mode, document_type=document_type)
    if cleaned:
        sentences = _important_sentences(cleaned, limit=3 if mode == "concise" else 6)
        summary["summary"] = sentences or [cleaned[:500]]
    summary["medications"] = _lines_matching(cleaned, ("mg", "tablet", "capsule", "dose", "medication", "medicine", "rx"), limit=8)
    summary["tests"] = _lines_matching(cleaned, ("test", "result", "glucose", "hba1c", "cholesterol", "blood", "urine", "x-ray", "mri", "ct"), limit=8)
    summary["warnings"] = _lines_matching(cleaned, ("warning", "abnormal", "high", "low", "critical", "urgent", "allergy"), limit=6)
    summary["follow_up"] = _lines_matching(cleaned, ("follow", "review", "consult", "appointment", "next visit"), limit=6)
    return summary


def merge_partial_summaries(partials: list[dict], *, mode: str, document_type: str) -> dict:
    merged = empty_summary(mode=mode, document_type=document_type)
    for partial in partials:
        if partial.get("type"):
            merged["type"] = partial.get("type")
        for key in ("summary", "medications", "tests", "warnings", "follow_up"):
            for item in as_list(partial.get(key)):
                if item and item not in merged[key]:
                    merged[key].append(item)
    return merged


def _important_sentences(text: str, *, limit: int) -> list[str]:
    lines = [normalize_item(line) for line in text.splitlines() if normalize_item(line)]
    if len(lines) <= limit:
        return lines
    keyword_lines = [
        line
        for line in lines
        if re.search(r"\b(patient|diagnosis|impression|result|medication|advice|follow|doctor|hospital)\b", line, re.I)
    ]
    selected = keyword_lines[:limit]
    if len(selected) < limit:
        selected.extend(line for line in lines if line not in selected)
    return selected[:limit]


def _lines_matching(text: str, keywords: tuple[str, ...], *, limit: int) -> list[str]:
    output: list[str] = []
    for line in text.splitlines():
        normalized = normalize_item(line)
        if not normalized:
            continue
        lower = normalized.lower()
        if any(keyword in lower for keyword in keywords) and normalized not in output:
            output.append(normalized)
        if len(output) >= limit:
            break
    return output
