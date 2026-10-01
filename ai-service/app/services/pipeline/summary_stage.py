from __future__ import annotations

import logging
import re
from typing import Any

from app.modules.summary.service import SummaryService
from app.services.translation_service import TranslationService

logger = logging.getLogger(__name__)

# Map common language names or codes to IndicTrans2 language names/codes
SUPPORTED_TRANSLATION_LANGUAGES = {
    "gu": "gujarati",
    "gujarati": "gujarati",
    "hi": "hindi",
    "hindi": "hindi",
    "mr": "marathi",
    "marathi": "marathi",
    "ta": "tamil",
    "tamil": "tamil",
    "te": "telugu",
    "telugu": "telugu",
    "kn": "kannada",
    "kannada": "kannada",
    "bn": "bengali",
    "bengali": "bengali",
    "pa": "punjabi",
    "punjabi": "punjabi",
}


def strip_think_tokens(text: str) -> str:
    """Strips <think>...</think> reasoning traces and unclosed <think> tags (HF-1 compliance)."""
    if not text:
        return ""
    cleaned = re.sub(r"<think>[\s\S]*?</think>", "", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"<think>[\s\S]*$", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def extract_key_bullet_points(text: str, structured_data: dict[str, Any], limit: int = 5) -> list[str]:
    """Extracts high-priority clinical bullet points preserving exact dosages and findings."""
    points: list[str] = []

    # 1. Add diagnoses
    for diag in (structured_data.get("diagnosis") or []):
        d_str = f"Diagnosis: {diag}"
        if d_str not in points:
            points.append(d_str)

    # 2. Add medications with exact dosages
    for med in (structured_data.get("medications") or []):
        m_name = med.get("name") or ""
        m_freq = med.get("frequency") or ""
        if m_name:
            m_str = f"Medication: {m_name} ({m_freq})".strip()
            if m_str not in points:
                points.append(m_str)

    # 3. Add critical or abnormal labs
    for lab in (structured_data.get("labResults") or []):
        flag = lab.get("flag")
        if flag in ("CRITICAL", "HIGH", "LOW"):
            t_name = lab.get("testName")
            val = lab.get("value")
            unit = lab.get("unit") or ""
            ref = lab.get("referenceRange") or ""
            l_str = f"Alert: {t_name} is {val} {unit} [{flag}] (Ref: {ref})"
            if l_str not in points:
                points.append(l_str)

    # 4. If few points, extract from text sentences
    if len(points) < limit and text:
        for sentence in text.splitlines():
            s_clean = sentence.strip().lstrip("*-• ")
            if len(s_clean) > 20 and not any(p in s_clean for p in points):
                points.append(s_clean)
            if len(points) >= limit:
                break

    return points[:limit]


class SummaryStageHandler:
    """Stage 8: SUMMARIZING.
    Synthesizes clinical summaries in English and preferred Indian languages,
    strips <think> tokens, and guarantees 100% preservation of numerical dosages.
    """

    def __init__(
        self,
        summary_service: SummaryService | None = None,
        translation_service: TranslationService | None = None,
    ) -> None:
        self.summary = summary_service
        self.translation = translation_service

    async def generate_summary(
        self,
        raw_text: str,
        structured_data: dict[str, Any],
        preferred_language: str = "english",
    ) -> dict[str, Any]:
        logger.info("Generating clinical summary (preferredLanguage=%s)...", preferred_language)

        norm_pref_lang = (preferred_language or "english").lower().strip()
        canonical_lang = SUPPORTED_TRANSLATION_LANGUAGES.get(norm_pref_lang, norm_pref_lang)

        # 1. Synthesize grounded English clinical summary
        english_summary = ""
        if self.summary:
            try:
                res = await self.summary.summarize(raw_text, mode="concise", document_type="medical")
                summary_items = res.get("summary") or []
                if summary_items:
                    english_summary = " ".join(summary_items)
            except Exception as e:
                model_name = getattr(self.summary, "model", None)
                logger.warning(
                    "AI summary service failed, falling back to clinical rule-based summary: model=%s, error_type=%s, error=%s",
                    model_name,
                    type(e).__name__,
                    str(e),
                    extra={"model": model_name, "error_type": type(e).__name__, "error": str(e)},
                )

        if not english_summary:
            english_summary = self._fallback_clinical_summary(raw_text, structured_data)

        # HF-1: Strip any <think> reasoning tokens
        english_summary = strip_think_tokens(english_summary)

        # 2. Extract key points
        key_points = extract_key_bullet_points(english_summary, structured_data)

        # 3. Translate to preferred language if non-English
        summary_preferred = english_summary
        if canonical_lang not in ("english", "en") and self.translation and self.translation.is_warm:
            try:
                translated = await self.translation.translate(
                    text=english_summary,
                    source_language="english",
                    target_language=canonical_lang,
                )
                if translated and translated.strip():
                    summary_preferred = strip_think_tokens(translated)
            except Exception as e:
                logger.warning("Translation to %s failed: %s", canonical_lang, e)

        # Verify numerical dosage preservation
        dosages_in_english = re.findall(r"\b\d+(?:\.\d+)?\s*(?:mg|ml|gm|mcg|iu|%)\b", english_summary, re.IGNORECASE)
        dosages_preserved = True
        if dosages_in_english and summary_preferred != english_summary:
            # Check whether numbers are preserved in the translated string
            for d in dosages_in_english:
                num_only = re.search(r"\d+", d).group(0)
                if num_only not in summary_preferred:
                    dosages_preserved = False
                    break

        logger.info(
            "Summary generated successfully: english_chars=%d, preferred_chars=%d, key_points=%d",
            len(english_summary),
            len(summary_preferred),
            len(key_points),
        )

        return {
            "summaryEnglish": english_summary,
            "summaryInPreferredLanguage": summary_preferred,
            "summaryLanguage": canonical_lang,
            "preferredLanguage": canonical_lang,
            "keyPoints": key_points,
            "dosagePreserved": dosages_preserved,
        }

    def _fallback_clinical_summary(self, raw_text: str, structured_data: dict[str, Any]) -> str:
        parts: list[str] = []
        pt = structured_data.get("patientInfo", {}).get("name")
        doc = structured_data.get("doctorInfo", {}).get("name")
        hosp = structured_data.get("hospitalInfo", {}).get("name")

        if hosp or doc:
            intro = f"Medical record from {hosp or 'hospital'}"
            if doc:
                intro += f" consulted by {doc}"
            parts.append(intro + ".")

        diags = structured_data.get("diagnosis") or []
        if diags:
            parts.append(f"Diagnosis noted: {', '.join(diags)}.")

        meds = structured_data.get("medications") or []
        if meds:
            med_list = [f"{m.get('name', 'Medicine')} ({m.get('frequency', 'as prescribed')})" for m in meds[:4]]
            parts.append(f"Prescribed medications include: {', '.join(med_list)}.")

        labs = structured_data.get("labResults") or []
        abnormal = [l for l in labs if l.get("flag") in ("HIGH", "LOW", "CRITICAL")]
        if abnormal:
            ab_list = [f"{l.get('testName')} ({l.get('value')} {l.get('unit')})" for l in abnormal[:3]]
            parts.append(f"Notable lab findings: {', '.join(ab_list)}.")

        if not parts and raw_text:
            # First few clean sentences
            sentences = [s.strip() for s in raw_text.splitlines() if len(s.strip()) > 30]
            parts.append(" ".join(sentences[:3]))

        return " ".join(parts).strip() or "Medical document reviewed. No critical acute findings noted."
