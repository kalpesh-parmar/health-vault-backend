from __future__ import annotations

import re


def decode_symbol_pua_text(text: str) -> str:
    if not text:
        return text
    out: list[str] = []
    changed = False
    for ch in text:
        code = ord(ch)
        if 0xF020 <= code <= 0xF0FE:
            mapped = code - 0xF000
            out.append(chr(mapped) if 32 <= mapped <= 126 else " ")
            changed = True
        else:
            out.append(ch)
    return "".join(out) if changed else text


NOISE_PATTERNS = (
    re.compile(r"^[^A-Za-z0-9]{2,}$"),
    re.compile(r"^[|_.,:;\-\s]{2,}$"),
    re.compile(r"^\d{1,2}$"),
)


def clean_ocr_text(text: str) -> str:
    lines = []
    seen: set[str] = set()
    for raw_line in (text or "").splitlines():
        line = normalize_line(raw_line)
        if not is_useful_line(line):
            continue
        key = line.lower()
        if key in seen:
            continue
        seen.add(key)
        lines.append(line)
    return merge_short_lines(lines)


def normalize_line(line: str) -> str:
    line = decode_symbol_pua_text(line or "")
    line = re.sub(r"\s+", " ", line).strip()
    line = re.sub(r"(?i)\b(\d+)\s*(mg|mcg|g|ml|iu|%)\b", r"\1 \2", line)
    return line


def is_useful_line(line: str) -> bool:
    if re.search(r"\d", line) and re.search(r"(?i)(\d+(\.\d+)?\s*(mg|mcg|g|ml|iu|%|mg/dl|mg/l|mmol/l|years?)\b|<\s*\d|\d+\s*-\s*\d|\d{1,2}[/-]\d{1,2}[/-]\d{2,4})", line):
        return True
    if re.fullmatch(r"\d+(?:\.\d+)?", line) and len(line) >= 2:
        return True
    if len(line) < 3:
        return False
    if any(pattern.match(line) for pattern in NOISE_PATTERNS):
        return False
    alpha_num = sum(ch.isalnum() for ch in line)
    return alpha_num / max(len(line), 1) >= 0.35


def merge_short_lines(lines: list[str]) -> str:
    merged: list[str] = []
    buffer = ""
    for line in lines:
        if len(line) < 24 and not line.endswith((".", ":", ";")):
            buffer = f"{buffer} {line}".strip()
            if len(buffer) < 48:
                continue
            merged.append(buffer)
            buffer = ""
        else:
            if buffer:
                merged.append(buffer)
                buffer = ""
            merged.append(line)
    if buffer:
        merged.append(buffer)
    return "\n".join(merged)


def compress_for_llm(text: str, *, max_chars: int) -> str:
    cleaned = clean_ocr_text(text)
    if len(cleaned) <= max_chars:
        return cleaned
    lines = cleaned.splitlines()
    priority = [
        line
        for line in lines
        if re.search(r"(?i)(rx|tablet|tab|cap|capsule|mg|ml|dose|daily|twice|thrice|test|result|doctor|diagnosis|follow)", line)
    ]
    default_lines = lines[: max(20, max_chars // 80)]
    compact = "\n".join(priority or default_lines)
    return compact[:max_chars].strip()
