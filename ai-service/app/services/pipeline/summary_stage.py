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

CLINICAL_TEST_ALIASES: dict[str, list[str]] = {
    "patients value (pt)": ["pt", "prothrombin", "prothrombin time"],
    "patient value (aptt)": ["aptt", "thromboplastin", "partial thromboplastin"],
    "random blood sugar": ["random blood sugar", "rbs", "blood sugar", "glucose"],
    "fasting blood sugar": ["fasting blood sugar", "fbs", "glucose"],
    "post prandial blood sugar": ["ppbs", "post prandial", "glucose"],
    "hba1c": ["hba1c", "a1c", "glycated hemoglobin"],
    "hematocrit/pcv": ["hematocrit", "pcv", "packed cell volume"],
    "rbc count": ["rbc", "red blood cell", "red blood cells", "erythrocyte"],
    "wbc count": ["wbc", "white blood cell", "white blood cells", "leukocyte"],
    "platelet count": ["platelet", "platelets", "thrombocyte"],
    "rdw-cv": ["rdw", "red cell distribution"],
    "hemoglobin": ["hemoglobin", "haemoglobin", "hb"],
}


def strip_think_tokens(text: str) -> str:
    """Strips <think>, <thinking>, <reasoning> reasoning traces and unclosed think tags (HF-1 compliance)."""
    if not text:
        return ""
    cleaned = re.sub(r"<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*?</(?:think|thinking|reasoning)>", "", text, flags=re.IGNORECASE)
    cleaned = re.sub(r"<(?:think|thinking|reasoning)\b[^>]*>[\s\S]*$", "", cleaned, flags=re.IGNORECASE)
    return cleaned.strip()


def is_abnormal_or_borderline(item: dict[str, Any]) -> bool:
    """Returns True if a lab parameter is clinically abnormal or borderline."""
    if item.get("is_informational") or item.get("status") == "info":
        return False
    st = str(item.get("status") or "").lower()
    sev = str(item.get("severity") or "").lower()
    flag = str(item.get("flag") or "").upper()

    if sev in ("borderline", "mild", "significant"):
        return True
    if st in ("low", "high", "abnormal", "borderline", "diabetic", "prediabetic"):
        return True
    if flag in ("LOW", "HIGH", "CRITICAL", "DIABETIC", "PREDIABETIC"):
        return True
    if item.get("isAbnormal") is True:
        return True
    return False


def build_deterministic_key_findings(structured_data: dict[str, Any]) -> list[dict[str, Any]]:
    """Builds deterministic key findings strictly in code from abnormal and borderline parameters."""
    raw_labs = structured_data.get("labResults") or []
    if not raw_labs and "groupedLabResults" in structured_data:
        for sec in structured_data.get("groupedLabResults", []):
            raw_labs.extend(sec.get("items") or [])

    seen_tests = set()
    findings: list[dict[str, Any]] = []

    for item in raw_labs:
        if not is_abnormal_or_borderline(item):
            continue

        name = (item.get("testName") or item.get("name") or "").strip()
        if not name or name.lower() in seen_tests:
            continue
        seen_tests.add(name.lower())

        val = item.get("value")
        unit = item.get("unit") or ""
        st = item.get("status") or item.get("computed_status") or "abnormal"
        sev = item.get("severity")
        ref = item.get("referenceRange") or item.get("reference_raw") or ""

        sev_desc = f", {sev} severity" if sev else ""
        ref_desc = f" (Ref: {ref})" if ref else ""
        finding_text = f"{name} is {val} {unit} [{st}{sev_desc}]{ref_desc}".strip()

        findings.append({
            "testName": name,
            "name": name,
            "value": val,
            "unit": unit,
            "status": st,
            "severity": sev,
            "referenceRange": ref,
            "finding": finding_text,
        })

    return findings


def format_abnormal_findings_prompt(key_findings: list[dict[str, Any]]) -> str:
    """Formats explicit abnormal test list with value, unit, status, severity, range."""
    if not key_findings:
        return ""
    lines = []
    for f in key_findings:
        name = f.get("testName") or f.get("name")
        val = f.get("value")
        unit = f.get("unit") or ""
        st = f.get("status")
        sev = f.get("severity") or "standard"
        ref = f.get("referenceRange") or "N/A"
        lines.append(f"- {name}: value={val} {unit}, status={st}, severity={sev}, range={ref}")

    items_str = "\n".join(lines)
    return (
        f"The following tests are abnormal:\n"
        f"{items_str}\n"
        f"Your summary MUST explain each of these."
    )


def verify_abnormal_parameters_present(
    key_findings: list[dict[str, Any]],
    summary_text: str,
) -> tuple[bool, list[str]]:
    """Verifies that all abnormal parameters are explained in the summary text."""
    if not key_findings:
        return True, []
    if not summary_text:
        return False, [f.get("testName") or f.get("name") for f in key_findings]

    norm_text = summary_text.lower()
    missing: list[str] = []

    for f in key_findings:
        test_name = (f.get("testName") or f.get("name") or "").strip()
        if not test_name:
            continue
        norm_name = test_name.lower()

        # 1. Exact / direct substring match
        if norm_name in norm_text:
            continue

        # 2. Check aliases and sub-tokens
        aliases = list(CLINICAL_TEST_ALIASES.get(norm_name, []))

        # Parenthetical parts e.g. "Patients Value (PT)" -> "patients value", "pt"
        m_paren = re.search(r"^(.*?)\s*\((.*?)\)", norm_name)
        if m_paren:
            p1, p2 = m_paren.group(1).strip(), m_paren.group(2).strip()
            if p1:
                aliases.append(p1)
            if p2:
                aliases.append(p2)

        # Slashes e.g. "Hematocrit/PCV" -> "hematocrit", "pcv"
        if "/" in norm_name:
            for part in norm_name.split("/"):
                if part.strip():
                    aliases.append(part.strip())

        # Hyphens e.g. "RDW-CV" -> "rdw"
        if "-" in norm_name:
            for part in norm_name.split("-"):
                if part.strip():
                    aliases.append(part.strip())

        # Trailing "count" e.g. "RBC Count" -> "rbc"
        if norm_name.endswith(" count"):
            aliases.append(norm_name[:-6].strip())

        matched = False
        for alias in aliases:
            alias = alias.strip()
            if not alias:
                continue
            if len(alias) <= 3:
                if re.search(r"\b" + re.escape(alias) + r"\b", norm_text):
                    matched = True
                    break
            else:
                if alias in norm_text or re.search(r"\b" + re.escape(alias), norm_text):
                    matched = True
                    break

        if not matched:
            missing.append(test_name)

    return len(missing) == 0, missing


def extract_key_bullet_points(
    text: str,
    structured_data: dict[str, Any],
    limit: int = 5,
    key_findings: list[dict[str, Any]] | None = None,
) -> list[str]:
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

    # 3. Add critical or abnormal labs from deterministic key findings
    findings_to_use = key_findings if key_findings is not None else build_deterministic_key_findings(structured_data)
    for f in findings_to_use:
        t_name = f.get("testName") or f.get("name")
        val = f.get("value")
        unit = f.get("unit") or ""
        st = f.get("status")
        ref = f.get("referenceRange") or ""
        l_str = f"Alert: {t_name} is {val} {unit} [{st}] (Ref: {ref})".strip()
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


def summary_is_sane(
    cand_summary: str,
    structured_data: dict[str, Any],
    key_findings: list[dict[str, Any]] | None = None,
) -> bool:
    """Clinical sanity gate for summary outputs.

    Rejects:
    1. Stringified dictionaries/JSON, e.g. "{'type': ..." or "{'summary': ..."
    2. Blatant clinical contradictions, such as claiming 'APTT is high' when APTT
       in structured lab results is clinically normal.
    """
    if not cand_summary or not isinstance(cand_summary, str):
        return False
    cand_clean = cand_summary.strip()
    if not cand_clean:
        return False

    # 1. Reject serialized dict/JSON structures
    if "{'type'" in cand_clean or '{"type"' in cand_clean or "{'summary'" in cand_clean or '{"summary"' in cand_clean:
        return False
    if cand_clean.startswith(("{", "[")) and (": " in cand_clean or ":'" in cand_clean or ':"' in cand_clean):
        return False

    cand_lower = cand_clean.lower()

    # 2. Check for APTT contradiction (claiming APTT is high/elevated when APTT is normal)
    lab_results = structured_data.get("labResults") or []
    aptt_is_normal = False
    for r in lab_results:
        t_name = str(r.get("testName", "")).lower()
        if "aptt" in t_name or "partial thromboplastin" in t_name:
            st = str(r.get("status", "")).lower()
            is_abnormal = bool(r.get("isAbnormal", False))
            if st in ("normal", "within normal limits", "optimal") or (st not in ("high", "elevated", "low") and not is_abnormal):
                aptt_is_normal = True
                break

    if aptt_is_normal:
        high_pat1 = re.search(r"\baptt\b[^.,;:!?\n]{0,30}\b(?:is\s+)?(?:high|elevated|prolonged|increased|abnormal)\b", cand_lower)
        high_pat2 = re.search(r"\b(?:high|elevated|prolonged|increased)\s+[^.,;:!?\n]{0,20}\baptt\b", cand_lower)
        if high_pat1 or high_pat2:
            return False

    return True


class SummaryStageHandler:
    """Stage 8: SUMMARIZING.
    Synthesizes clinical summaries grounded in deterministic code statuses,
    strips <think> tokens, verifies parameter coverage, and guarantees dosage preservation.
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

        # 1. Deterministic key findings
        key_findings = build_deterministic_key_findings(structured_data)
        abnormal_prompt = format_abnormal_findings_prompt(key_findings)

        # 2. Synthesize grounded English clinical summary
        english_summary = ""
        if self.summary:
            try:
                # Attempt 1
                try:
                    res = await self.summary.summarize(
                        raw_text,
                        mode="concise",
                        document_type="medical",
                        abnormal_findings=abnormal_prompt,
                    )
                except TypeError:
                    combined_text = f"{abnormal_prompt}\n\n{raw_text}" if abnormal_prompt else raw_text
                    res = await self.summary.summarize(
                        combined_text,
                        mode="concise",
                        document_type="medical",
                    )
                summary_items = res.get("summary") or []
                if summary_items:
                    cand_summary = strip_think_tokens(" ".join(summary_items))
                    is_valid, missing = verify_abnormal_parameters_present(key_findings, cand_summary)
                    is_sane = summary_is_sane(cand_summary, structured_data, key_findings=key_findings)
                    if is_valid and is_sane:
                        english_summary = cand_summary
                    else:
                        logger.warning(
                            "Summary rejected (valid=%s, sane=%s, missing=%s). Retrying once with strict prompt...",
                            is_valid,
                            is_sane,
                            missing,
                        )
                        retry_instruction = (
                            f"RETRY INSTRUCTION: Your previous summary omitted the following abnormal tests: {', '.join(missing)}.\n"
                            f"{abnormal_prompt}\n"
                            f"You MUST explain each of these abnormal tests in your summary."
                        )
                        try:
                            retry_res = await self.summary.summarize(
                                raw_text,
                                mode="concise",
                                document_type="medical",
                                abnormal_findings=retry_instruction,
                            )
                        except TypeError:
                            retry_combined = f"{retry_instruction}\n\n{raw_text}"
                            retry_res = await self.summary.summarize(
                                retry_combined,
                                mode="concise",
                                document_type="medical",
                            )
                        retry_items = retry_res.get("summary") or []
                        if retry_items:
                            retry_cand = strip_think_tokens(" ".join(retry_items))
                            is_retry_valid, retry_missing = verify_abnormal_parameters_present(key_findings, retry_cand)
                            is_retry_sane = summary_is_sane(retry_cand, structured_data, key_findings=key_findings)
                            if is_retry_valid and is_retry_sane:
                                english_summary = retry_cand
                            else:
                                logger.warning(
                                    "Summary rejected after retry (valid=%s, sane=%s, missing=%s). Falling back to deterministic structured summary.",
                                    is_retry_valid,
                                    is_retry_sane,
                                    retry_missing,
                                )
                                english_summary = self._fallback_clinical_summary(raw_text, structured_data, key_findings=key_findings)
                        else:
                            english_summary = self._fallback_clinical_summary(raw_text, structured_data, key_findings=key_findings)
            except Exception as e:
                model_name = getattr(self.summary, "model", None)
                logger.warning(
                    "AI summary service failed, falling back to clinical rule-based summary: model=%s, error_type=%s, error=%s",
                    model_name,
                    type(e).__name__,
                    str(e),
                    extra={"model": model_name, "error_type": type(e).__name__, "error": str(e)},
                )

        if not english_summary or not summary_is_sane(english_summary, structured_data, key_findings=key_findings):
            english_summary = self._fallback_clinical_summary(raw_text, structured_data, key_findings=key_findings)

        # HF-1: Strip any <think> reasoning tokens
        english_summary = strip_think_tokens(english_summary)

        # 3. Extract key points
        key_points = extract_key_bullet_points(english_summary, structured_data, key_findings=key_findings)

        # 4. Translate to preferred language if non-English
        summary_preferred = english_summary
        summary_language = "english"
        translation_status = "SUCCESS" if canonical_lang in ("english", "en") else "FAILED"

        if canonical_lang not in ("english", "en"):
            if self.translation and self.translation.is_warm:
                try:
                    translated = await self.translation.translate(
                        text=english_summary,
                        src_lang="english",
                        tgt_lang=canonical_lang,
                    )
                    if translated and translated.strip():
                        cleaned_trans = strip_think_tokens(translated)
                        from app.modules.ocr.fallback_validator import FallbackOutputValidator
                        val = FallbackOutputValidator()
                        is_valid_script, ratio, _ = val.validate_target_script(cleaned_trans, canonical_lang)
                        if is_valid_script and ratio >= 0.5:
                            summary_preferred = cleaned_trans
                            summary_language = canonical_lang
                            translation_status = "SUCCESS"
                        else:
                            logger.warning(
                                "Translation to %s rejected due to insufficient script ratio (%.2f < 0.5)",
                                canonical_lang,
                                ratio,
                            )
                            summary_preferred = english_summary
                            summary_language = "english"
                            translation_status = "FAILED"
                    else:
                        summary_preferred = english_summary
                        summary_language = "english"
                        translation_status = "FAILED"
                except Exception as e:
                    logger.warning("Translation to %s failed: %s", canonical_lang, e)
                    summary_preferred = english_summary
                    summary_language = "english"
                    translation_status = "FAILED"
            else:
                summary_preferred = english_summary
                summary_language = "english"
                translation_status = "FAILED"

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
            "Summary generated successfully: english_chars=%d, preferred_chars=%d, key_points=%d, key_findings=%d",
            len(english_summary),
            len(summary_preferred),
            len(key_points),
            len(key_findings),
        )

        return {
            "summaryEnglish": english_summary,
            "summaryInPreferredLanguage": summary_preferred,
            "summaryLanguage": summary_language,
            "preferredLanguage": canonical_lang,
            "translationStatus": translation_status,
            "keyPoints": key_points,
            "keyFindings": key_findings,
            "key_findings": key_findings,
            "dosagePreserved": dosages_preserved,
        }

    def _fallback_clinical_summary(
        self,
        raw_text: str,
        structured_data: dict[str, Any],
        key_findings: list[dict[str, Any]] | None = None,
    ) -> str:
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

        findings_to_use = key_findings if key_findings is not None else build_deterministic_key_findings(structured_data)
        if findings_to_use:
            ab_list = []
            for f in findings_to_use:
                name = f.get("testName") or f.get("name")
                val = f.get("value")
                unit = f.get("unit") or ""
                st = f.get("status")
                sev = f.get("severity")
                ref = f.get("referenceRange") or f.get("reference_raw")
                sev_desc = f", {sev} severity" if sev else ""
                ref_desc = f" (Ref: {ref})" if ref else ""
                ab_list.append(f"{name} is {val} {unit} [{st}{sev_desc}]{ref_desc}".strip())
            parts.append(f"Notable lab findings: {'; '.join(ab_list)}.")
        else:
            labs = structured_data.get("labResults") or []
            abnormal = [l for l in labs if l.get("flag") in ("HIGH", "LOW", "CRITICAL", "diabetic", "prediabetic")]
            if abnormal:
                ab_list = [f"{l.get('testName')} ({l.get('value')} {l.get('unit')})" for l in abnormal[:3]]
                parts.append(f"Notable lab findings: {', '.join(ab_list)}.")

        if not parts and raw_text:
            sentences = [s.strip() for s in raw_text.splitlines() if len(s.strip()) > 30]
            parts.append(" ".join(sentences[:3]))

        return " ".join(parts).strip() or "Medical document reviewed. No critical acute findings noted."

