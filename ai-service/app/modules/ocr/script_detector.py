from __future__ import annotations

import re
from typing import Any

# Unicode block ranges
UNICODE_SCRIPT_RANGES = {
    "devanagari": (0x0900, 0x097F),
    "bengali": (0x0980, 0x09FF),
    "gujarati": (0x0A80, 0x0AFF),
    "tamil": (0x0B80, 0x0BFF),
    "telugu": (0x0C00, 0x0C7F),
    "kannada": (0x0C80, 0x0CFF),
    "malayalam": (0x0D00, 0x0D7F),
    "latin": (0x0020, 0x00FF),
}


def get_character_script(char: str) -> str:
    """Identify the script of an individual character based on Unicode codepoint."""
    if len(char) != 1:
        return "unknown"
    cp = ord(char)
    # Check Indic scripts first
    for script_name, (start_cp, end_cp) in UNICODE_SCRIPT_RANGES.items():
        if script_name != "latin" and start_cp <= cp <= end_cp:
            return script_name
    # Check Latin
    if (0x0041 <= cp <= 0x005A) or (0x0061 <= cp <= 0x007A) or (0x00C0 <= cp <= 0x00FF):
        return "latin"
    if 0x0030 <= cp <= 0x0039:
        return "digit"
    if cp in (0x20, 0x09, 0x0A, 0x0D):
        return "whitespace"
    return "symbol"


def detect_scripts_in_text(text: str) -> dict[str, Any]:
    """Inspects text and returns counts and proportions for each script."""
    counts: dict[str, int] = {}
    total_letters = 0
    non_latin_count = 0

    for ch in text:
        script = get_character_script(ch)
        counts[script] = counts.get(script, 0) + 1
        if script not in {"digit", "whitespace", "symbol", "unknown"}:
            total_letters += 1
            if script != "latin":
                non_latin_count += 1

    detected_scripts = [s for s, c in counts.items() if s not in {"digit", "whitespace", "symbol"} and c > 0]
    dominant = "latin"
    if total_letters > 0:
        script_letters = {s: c for s, c in counts.items() if s not in {"digit", "whitespace", "symbol"}}
        if script_letters:
            dominant = max(script_letters, key=script_letters.get)

    return {
        "counts": counts,
        "total_letters": total_letters,
        "non_latin_count": non_latin_count,
        "has_non_latin": non_latin_count > 0,
        "detected_scripts": detected_scripts,
        "dominant_script": dominant,
    }


def inspect_ocr_lines_for_non_latin(
    lines: list[dict[str, Any]],
    confidence_floor: float = 0.70,
) -> dict[str, Any]:
    """Inspects OCR lines for either:
    1. Explicit non-Latin characters (Devanagari, Gujarati, Tamil, etc.).
    2. Anomalous low-confidence line recognition produced when an English OCR model
       attempts to transcribe Indic script (e.g. '30Eqyu', conf < 0.70 with non-English n-grams).
    """
    detected_scripts: set[str] = set()
    non_latin_char_count = 0
    anomalous_lines: list[dict[str, Any]] = []

    for idx, l in enumerate(lines):
        text = str(l.get("text") or "").strip()
        conf = float(l.get("confidence") or 0.0)

        # Check explicit Unicode codepoints
        script_res = detect_scripts_in_text(text)
        if script_res["has_non_latin"]:
            detected_scripts.update(script_res["detected_scripts"])
            non_latin_char_count += script_res["non_latin_count"]

        # Check for unread line fragment: low confidence with non-dictionary orthography
        # e.g. line 32 '30Eqyu' conf 0.5907
        if conf < confidence_floor and text:
            is_anomalous = bool(
                ("Eqy" in text) or
                ("qyu" in text) or
                (len(text) < 15 and any(c.isupper() for c in text[1:]) and any(c.islower() for c in text)) or
                (re.search(r"[0-9]+[A-Za-z]{3,}", text) and not re.search(r"(mg|ml|tab|cap|gm|kg)", text, re.I))
            )
            if is_anomalous:
                anomalous_lines.append({
                    "line_index": idx,
                    "text": text,
                    "confidence": conf,
                    "box": l.get("box"),
                })

    has_potential = bool(anomalous_lines or (non_latin_char_count > 0))

    return {
        "has_non_latin": non_latin_char_count > 0,
        "non_latin_char_count": non_latin_char_count,
        "detected_scripts": list(detected_scripts),
        "has_potential_unread_non_latin": has_potential,
        "anomalous_lines": anomalous_lines,
    }
