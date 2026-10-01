from __future__ import annotations

"""Direct PDF text extraction via PyMuPDF with per-page text sanitization and garble gating."""

import asyncio
import logging
import re
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
import fitz

logger = logging.getLogger(__name__)

MIN_INFORMATIVE_CHARS_PER_PAGE = 20
MIN_TOTAL_CHARS = 100
MIN_INFORMATIVE_PAGE_FRACTION = 0.4
# Medical lab reports are dominated by numbers, units, ranges, and dates, so a
# high alphabetic ratio is the WRONG signal — it routes valid text PDFs to the
# vision OCR pipeline. We only use alpha_ratio to reject obvious binary/garbage
# extractions, hence a very low floor.
MIN_ALPHA_RATIO = 0.10
# A document with at least this many alphanumeric characters is treated as
# having real, extractable text regardless of the alpha ratio (covers dense
# numeric lab tables).
MIN_ALNUM_CHARS = 80

_WHITESPACE_RUN = re.compile(r"[ \t\f\v]+")
_TRAILING_BLANK_LINES = re.compile(r"\n\s*\n+")

# Detection patterns for font corruption and garble
_CID_PATTERN = re.compile(r"\(cid:\d+\)")
_UNICODE_REPLACEMENT_CHAR = "\ufffd"
_CONSONANT_CLUSTER_RE = re.compile(r"[bcdfghjklmnpqrstvwxyz]{4,}", re.IGNORECASE)

# Legacy 8-bit Indic font families mapping Devanagari/Indic glyphs to Latin ASCII code points
LEGACY_INDIC_FONT_PATTERNS = [
    re.compile(r"kruti", re.IGNORECASE),
    re.compile(r"shree", re.IGNORECASE),
    re.compile(r"walkman", re.IGNORECASE),
    re.compile(r"chanakya", re.IGNORECASE),
    re.compile(r"devlys", re.IGNORECASE),
    re.compile(r"akruti", re.IGNORECASE),
    re.compile(r"aps[-_]?dv", re.IGNORECASE),
    re.compile(r"aps[-_]?c", re.IGNORECASE),
    re.compile(r"dv[-_]?tt", re.IGNORECASE),
    re.compile(r"kiran", re.IGNORECASE),
    re.compile(r"shivaji", re.IGNORECASE),
    re.compile(r"bilingual", re.IGNORECASE),
]

# Medical terms, tests, acronyms, and units strictly whitelisted to prevent false rejections
MEDICAL_WHITELIST = frozenset({
    # Hematology & Biochemistry
    "wbc", "rbc", "hgb", "hb", "hct", "mcv", "mch", "mchc", "rdw", "plt",
    "sgot", "sgpt", "ast", "alt", "alp", "ggt", "ldh", "cpk", "bun", "crp",
    "esr", "tsh", "ft3", "ft4", "t3", "t4", "hba1c", "psa", "vldl", "hdl", "ldl",
    # Vitals & Clinical Tests
    "bp", "spo2", "pr", "rr", "bmi", "bsa", "ecg", "ekg", "eeg", "emg", "ct", "mri",
    "usg", "cxr", "pft", "abg", "inr", "pt", "aptt", "fbs", "ppbs", "rbs",
    # Units of Measure
    "mg/dl", "g/dl", "ug/dl", "mcg/dl", "ng/ml", "pg/ml", "pmol/l", "mmol/l",
    "meq/l", "iu/l", "u/l", "mu/l", "mmhg", "bpm", "fl", "pg", "cells/cumm",
    "cumm", "thou/cumm", "mill/cumm", "gm%", "mg%", "vol%",
    # Common Prescriptions & Forms
    "tab", "cap", "syp", "inj", "oint", "dr", "pt", "opd", "ipd", "rx", "sos",
    "od", "bd", "tid", "qid", "hs", "bbf", "pc", "ac", "po", "iv", "im", "sc",
    # Additional common clinical acronyms
    "cbc", "lft", "kft", "rft", "tft", "hiv", "hbsag", "hcv", "vdrl",
})

# Words with valid 4+ consonant clusters in standard English
_ENGLISH_CONSONANT_EXEMPTIONS = frozenset({
    "lengths", "strengths", "angst", "catchphrase", "watchstrap", "birthplace", "archdruid",
})

# High-frequency English medical and report vocabulary for lexical validity check
_COMMON_LEXICON = frozenset({
    "patient", "name", "age", "gender", "male", "female", "date", "doctor", "hospital",
    "clinic", "report", "test", "result", "reference", "interval", "normal", "high",
    "low", "unit", "blood", "serum", "urine", "specimen", "investigation", "department",
    "pathology", "verified", "authorized", "sign", "signature", "notes", "clinical",
    "remarks", "history", "sample", "collected", "reported", "status", "address",
    "phone", "reg", "id", "no", "page", "total", "count", "value", "method", "serology",
    "biochemistry", "hematology", "microbiology", "impression", "interpretation", "finding",
    "findings", "advice", "treatment", "diagnosis", "prescription", "consultation", "medical",
    "health", "care", "center", "centre", "laboratory", "labs", "diagnostic", "diagnostics",
    "the", "of", "and", "in", "to", "for", "with", "on", "at", "by", "from", "is", "was",
    "are", "were", "been", "has", "have", "had", "this", "that", "these", "those", "not",
    "or", "as", "an", "be", "all", "any", "each", "every", "both", "few", "more", "most",
    "other", "some", "such", "than", "too", "very", "can", "will", "just", "should", "now",
    "years", "year", "months", "days", "hours", "yrs", "yr", "mo", "dob",
}) | MEDICAL_WHITELIST


def decode_symbol_pua_text(text: str) -> str:
    """Decode PDFs that expose WinAnsi text through the Unicode PUA.

    Some lab-report PDFs embed normal ASCII text using custom fonts, but
    PyMuPDF returns characters in the private-use range U+F020..U+F0FE.
    For example, ``\uf052\uf065\uf070\uf06f\uf072\uf074`` is actually
    ``Report``. Subtracting 0xF000 restores the original byte/ASCII value.
    """
    if not text:
        return text

    decoded: list[str] = []
    changed = False
    for ch in text:
        code = ord(ch)
        if 0xF020 <= code <= 0xF0FE:
            mapped = code - 0xF000
            # Keep printable ASCII directly. Map common symbolic bullets to a
            # safe separator so downstream text cleanup can read the sentence.
            if 32 <= mapped <= 126:
                decoded.append(chr(mapped))
            elif mapped in {0xD8, 0xD9, 0xDA, 0xDF, 0xE0}:
                decoded.append("•")
            else:
                decoded.append(" ")
            changed = True
        else:
            decoded.append(ch)

    return "".join(decoded) if changed else text


@dataclass(frozen=True)
class PageTextValidationResult:
    page_number: int
    text: str
    is_valid_direct_text: bool
    rejection_reason: str | None  # "CID_CORRUPTION", "UNICODE_REPLACEMENT", "LEGACY_INDIC_FONT", "PHONOTACTIC_GARBLE", "INSUFFICIENT_TEXT", or None
    metrics: dict[str, Any] = field(default_factory=dict)


def detect_cid_artifacts(text: str) -> tuple[bool, float, int]:
    """Detect (cid:...) font artifacts from missing ToUnicode CMap tables."""
    if not text:
        return False, 0.0, 0
    cid_matches = _CID_PATTERN.findall(text)
    cid_count = len(cid_matches)
    tokens = text.split()
    total_tokens = max(len(tokens), 1)
    cid_token_ratio = cid_count / total_tokens
    # Flag if > 5% of tokens are CID patterns, or any CID in sparse text (< 20 tokens)
    is_flagged = (cid_token_ratio > 0.05) or (cid_count > 0 and len(tokens) < 20)
    return is_flagged, round(cid_token_ratio, 4), cid_count


def detect_replacement_chars(text: str) -> tuple[bool, float, int]:
    """Detect Unicode replacement character \ufffd artifacts."""
    if not text:
        return False, 0.0, 0
    repl_count = text.count(_UNICODE_REPLACEMENT_CHAR)
    total_chars = max(len(text), 1)
    ratio = repl_count / total_chars
    # Flag if > 2% of chars are replacement characters, or at least 3 occurrences in short text
    is_flagged = (ratio > 0.02) or (repl_count >= 3 and len(text) < 100)
    return is_flagged, round(ratio, 4), repl_count


def detect_legacy_indic_fonts(doc: Any, page_number: int) -> tuple[bool, list[str]]:
    """Inspect page font table for known 8-bit legacy Indic font families."""
    if doc is None:
        return False, []
    page_idx = page_number - 1
    try:
        if hasattr(doc, "page_count") and 0 <= page_idx < doc.page_count:
            page = doc.load_page(page_idx)
        elif hasattr(doc, "__len__") and 0 <= page_idx < len(doc):
            page = doc[page_idx]
        else:
            return False, []

        if not hasattr(page, "get_fonts"):
            return False, []

        font_list = page.get_fonts(full=True)
        matched_fonts: list[str] = []
        for font in font_list:
            # font tuple format: (xref, ext, type, basefont, name, encoding, ...)
            basefont = str(font[3]) if len(font) > 3 else ""
            name = str(font[4]) if len(font) > 4 else ""
            for pat in LEGACY_INDIC_FONT_PATTERNS:
                if pat.search(basefont) or pat.search(name):
                    matched_fonts.append(basefont or name)
                    break
        return bool(matched_fonts), matched_fonts
    except Exception as exc:
        logger.warning("Failed to inspect fonts for page %d: %s", page_number, exc)
        return False, []


def detect_phonotactic_garble(text: str) -> tuple[bool, float, list[str]]:
    """Detect unnatural Latin consonant sequences and low lexical valid ratios."""
    if not text:
        return False, 0.0, []

    words = re.findall(r"[A-Za-z0-9%/+\.\-]+", text)
    if not words:
        return False, 0.0, []

    anomalous_tokens: list[str] = []
    alpha_words: list[str] = []

    for raw_w in words:
        w_clean = raw_w.strip(".,;:()[]{}%/-")
        if not w_clean:
            continue
        w_lower = w_clean.lower()
        if w_clean.isdigit():
            continue
        if any(ch.isalpha() for ch in w_clean):
            alpha_words.append(w_lower)

        # Check exemptions
        if w_lower in MEDICAL_WHITELIST or w_lower in _ENGLISH_CONSONANT_EXEMPTIONS:
            continue

        # Check 4+ consonant cluster or mid-word casing anomaly (e.g. LFkku, vLirky)
        has_consonant_cluster = bool(_CONSONANT_CLUSTER_RE.search(w_clean))
        has_mid_uppercase = bool(re.search(r"[a-z][A-Z]", w_clean))

        if has_consonant_cluster or has_mid_uppercase:
            anomalous_tokens.append(w_clean)

    total_alpha = max(len(alpha_words), 1)
    anomaly_ratio = len(anomalous_tokens) / total_alpha

    # Lexical validity check on text with substantial content
    lexical_ratio = 1.0
    if len(alpha_words) >= 8 and len(text) >= 80:
        valid_lexical_count = sum(1 for w in alpha_words if w in _COMMON_LEXICON)
        lexical_ratio = valid_lexical_count / total_alpha

    # Flag conditions:
    # 1. More than 2 anomalous tokens and anomaly ratio >= 3%
    # 2. Or single anomalous token in very short text (< 15 alpha words)
    # 3. Or text >= 80 chars and lexical ratio < 20% and at least 1 anomalous token
    is_flagged = (
        (len(anomalous_tokens) >= 2 and anomaly_ratio >= 0.03)
        or (len(anomalous_tokens) >= 1 and len(alpha_words) < 15 and anomaly_ratio > 0.10)
        or (len(text) >= 80 and len(alpha_words) >= 8 and lexical_ratio < 0.20 and len(anomalous_tokens) >= 1)
    )

    metric = round(anomaly_ratio if is_flagged else (1.0 - lexical_ratio), 4)
    return is_flagged, metric, anomalous_tokens


def validate_page_direct_text(
    doc: Any,
    page_number: int,
    text: str,
) -> PageTextValidationResult:
    """Run all text sanitization gates on a single page in strict priority order."""
    cleaned = _clean_page_text(text)

    # 1. Minimum informative length check
    if len(cleaned.strip()) < MIN_INFORMATIVE_CHARS_PER_PAGE:
        return PageTextValidationResult(
            page_number=page_number,
            text=cleaned,
            is_valid_direct_text=False,
            rejection_reason="INSUFFICIENT_TEXT",
            metrics={"char_count": len(cleaned.strip()), "min_required": MIN_INFORMATIVE_CHARS_PER_PAGE},
        )

    # 2. Legacy Indic font check in font table
    has_legacy_font, legacy_fonts = detect_legacy_indic_fonts(doc, page_number)
    if has_legacy_font:
        return PageTextValidationResult(
            page_number=page_number,
            text=cleaned,
            is_valid_direct_text=False,
            rejection_reason="LEGACY_INDIC_FONT",
            metrics={"detected_fonts": legacy_fonts},
        )

    # 3. CID corruption check
    is_cid, cid_ratio, cid_count = detect_cid_artifacts(cleaned)
    if is_cid:
        return PageTextValidationResult(
            page_number=page_number,
            text=cleaned,
            is_valid_direct_text=False,
            rejection_reason="CID_CORRUPTION",
            metrics={"cid_ratio": cid_ratio, "cid_count": cid_count},
        )

    # 4. Unicode replacement character check
    is_repl, repl_ratio, repl_count = detect_replacement_chars(cleaned)
    if is_repl:
        return PageTextValidationResult(
            page_number=page_number,
            text=cleaned,
            is_valid_direct_text=False,
            rejection_reason="UNICODE_REPLACEMENT",
            metrics={"replacement_ratio": repl_ratio, "replacement_count": repl_count},
        )

    # 5. Phonotactic / lexical garble check
    is_garble, garble_metric, anomalous_tokens = detect_phonotactic_garble(cleaned)
    if is_garble:
        return PageTextValidationResult(
            page_number=page_number,
            text=cleaned,
            is_valid_direct_text=False,
            rejection_reason="PHONOTACTIC_GARBLE",
            metrics={"metric": garble_metric, "anomalous_tokens": anomalous_tokens},
        )

    # All gates passed: valid direct text
    return PageTextValidationResult(
        page_number=page_number,
        text=cleaned,
        is_valid_direct_text=True,
        rejection_reason=None,
        metrics={"char_count": len(cleaned), "alpha_ratio": round(_alpha_ratio(cleaned), 3)},
    )


@dataclass(frozen=True)
class DirectPdfPage:
    page_number: int
    text: str
    char_count: int
    validation: PageTextValidationResult | None = None


@dataclass(frozen=True)
class DirectPdfExtraction:
    pages: list[DirectPdfPage]
    full_text: str
    char_count: int
    elapsed_ms: int

    def to_paragraphs(self) -> list[dict]:
        paragraphs: list[dict] = []
        for page in self.pages:
            for order, line in enumerate(_split_lines(page.text)):
                paragraphs.append(
                    {
                        "text": line,
                        "page": page.page_number,
                        "order": order,
                        "label": "paragraph",
                        "confidence": 1.0,
                    }
                )
        return paragraphs

    def to_extraction_result(self) -> dict:
        page_payloads = [
            {
                "page": page.page_number,
                "text": page.text,
                "confidence": 1.0,
                "lines": [
                    {"text": line, "confidence": 1.0}
                    for line in _split_lines(page.text)
                ],
                "elapsed_ms": 0,
            }
            for page in self.pages
        ]
        return {
            "pages": page_payloads,
            "text": self.full_text,
            "fullText": self.full_text,
            "confidence": 1.0,
            "pageCount": len(self.pages),
            "processedPageCount": len(self.pages),
            "paragraphs": self.to_paragraphs(),
        }


def _split_lines(text: str) -> list[str]:
    return [line.strip() for line in (text or "").splitlines() if line.strip()]


def _clean_page_text(raw: str) -> str:
    decoded = decode_symbol_pua_text(raw or "")
    cleaned = _WHITESPACE_RUN.sub(" ", decoded)
    cleaned = _TRAILING_BLANK_LINES.sub("\n\n", cleaned)
    return cleaned.strip()


def _alpha_ratio(text: str) -> float:
    if not text:
        return 0.0
    alpha = sum(1 for ch in text if ch.isalpha())
    return alpha / max(len(text), 1)


def _alnum_count(text: str) -> int:
    return sum(1 for ch in text if ch.isalnum())


def _extract_from_doc(
    doc,
    *,
    max_pages: int | None,
    require_quality: bool = True,
) -> DirectPdfExtraction | None:
    t0 = time.monotonic()
    logger.info("pdf_text_extraction_started", extra={"page_count": int(doc.page_count)})
    pages: list[DirectPdfPage] = []
    full_text_parts: list[str] = []

    page_limit = doc.page_count if max_pages is None else min(max_pages, doc.page_count)
    for index in range(page_limit):
        page_number = index + 1
        try:
            raw = doc.load_page(index).get_text("text") or ""
        except Exception:
            logger.exception("pdf_text_page_failed", extra={"page": page_number})
            raw = ""
        val_res = validate_page_direct_text(doc, page_number, raw)
        pages.append(
            DirectPdfPage(
                page_number=page_number,
                text=val_res.text,
                char_count=len(val_res.text),
                validation=val_res,
            )
        )
        if val_res.is_valid_direct_text and val_res.text:
            full_text_parts.append(val_res.text)

    full_text = "\n\n".join(full_text_parts).strip()
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    if not pages:
        logger.info("pdf_text_extraction_completed", extra={"page_count": 0, "char_count": 0, "elapsed_ms": elapsed_ms})
        return None

    # Check for any invalid/corrupted pages across the document
    invalid_pages = [p for p in pages if not (p.validation and p.validation.is_valid_direct_text)]
    if require_quality and invalid_pages:
        reasons = [p.validation.rejection_reason for p in invalid_pages if p.validation]
        logger.info(
            "pdf_text_page_validation_rejected",
            extra={
                "page_count": len(pages),
                "invalid_page_count": len(invalid_pages),
                "rejection_reasons": reasons,
                "elapsed_ms": elapsed_ms,
            },
        )
        return None

    informative_pages = sum(
        1 for page in pages if page.char_count >= MIN_INFORMATIVE_CHARS_PER_PAGE
    )
    informative_fraction = informative_pages / len(pages)
    alpha_ratio = _alpha_ratio(full_text)
    alnum_chars = _alnum_count(full_text)

    logger.info(
        "pdf_text_extraction_completed",
        extra={
            "page_count": len(pages),
            "char_count": len(full_text),
            "alnum_chars": alnum_chars,
            "informative_pages": informative_pages,
            "informative_fraction": round(informative_fraction, 3),
            "alpha_ratio": round(alpha_ratio, 3),
            "elapsed_ms": elapsed_ms,
        },
    )

    # Accept when the document clearly has real text. Two independent signals:
    #   (a) enough total alphanumerics on enough pages (handles numeric medical
    #       tables that have a LOW alpha ratio), OR
    #   (b) the legacy length+fraction+alpha gate.
    # We only reject when there is genuinely too little text to be useful — in
    # which case the page is image-only/scanned and belongs to the OCR path.
    has_enough_text = (
        alnum_chars >= MIN_ALNUM_CHARS
        and informative_fraction >= MIN_INFORMATIVE_PAGE_FRACTION
        and alpha_ratio >= MIN_ALPHA_RATIO
    )
    legacy_gate = (
        len(full_text) >= MIN_TOTAL_CHARS
        and informative_fraction >= MIN_INFORMATIVE_PAGE_FRACTION
        and alpha_ratio >= MIN_ALPHA_RATIO
    )
    if require_quality and not (has_enough_text or legacy_gate):
        logger.info(
            "pdf_text_insufficient_for_direct",
            extra={
                "char_count": len(full_text),
                "alnum_chars": alnum_chars,
                "alpha_ratio": round(alpha_ratio, 3),
                "informative_fraction": round(informative_fraction, 3),
                "reason": "image_only_or_scanned",
            },
        )
        return None

    if not full_text and require_quality:
        logger.info(
            "pdf_text_insufficient_for_direct",
            extra={
                "char_count": 0,
                "alnum_chars": 0,
                "alpha_ratio": 0,
                "informative_fraction": 0,
                "reason": "empty_text",
            },
        )
        return None

    logger.info(
        "pdf_text_detected",
        extra={"page_count": len(pages), "char_count": len(full_text), "alnum_chars": alnum_chars},
    )
    # Assemble full text for raw return if not requiring quality (all pages)
    return_full_text = full_text if full_text else "\n\n".join(p.text for p in pages if p.text).strip()
    return DirectPdfExtraction(
        pages=pages,
        full_text=return_full_text,
        char_count=len(return_full_text),
        elapsed_ms=elapsed_ms,
    )


def _extract_bytes_sync(
    pdf_bytes: bytes,
    *,
    max_pages: int | None,
    require_quality: bool = True,
) -> DirectPdfExtraction | None:
    try:
        with fitz.open(stream=pdf_bytes, filetype="pdf") as doc:
            return _extract_from_doc(doc, max_pages=max_pages, require_quality=require_quality)
    except Exception:
        logger.exception("pdf_text_open_failed")
        return None


def _extract_path_sync(pdf_path: Path, *, max_pages: int | None) -> DirectPdfExtraction | None:
    try:
        with fitz.open(str(pdf_path)) as doc:
            return _extract_from_doc(doc, max_pages=max_pages)
    except Exception:
        logger.exception("pdf_text_open_failed", extra={"path": str(pdf_path)})
        return None


async def try_extract_pdf_text_from_bytes(
    pdf_bytes: bytes,
    *,
    max_pages: int | None = None,
) -> DirectPdfExtraction | None:
    return await asyncio.to_thread(_extract_bytes_sync, pdf_bytes, max_pages=max_pages, require_quality=True)


async def extract_pdf_text_pages_from_bytes(
    pdf_bytes: bytes,
    *,
    max_pages: int | None = None,
) -> DirectPdfExtraction | None:
    """Return extractable page text without the document-level quality gate.

    OCR routing uses this for the fast first pass. Even when the full document
    would fail the legacy direct-text gate, real text on one or more pages is
    still valuable and should prevent unnecessary vision calls.
    """
    return await asyncio.to_thread(_extract_bytes_sync, pdf_bytes, max_pages=max_pages, require_quality=False)


async def try_extract_pdf_text(
    pdf_path: Path,
    *,
    max_pages: int | None = None,
) -> DirectPdfExtraction | None:
    return await asyncio.to_thread(_extract_path_sync, pdf_path, max_pages=max_pages)
