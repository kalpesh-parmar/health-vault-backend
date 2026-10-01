from __future__ import annotations

import io
import logging
import re
import time
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass, field
from typing import Any

logger = logging.getLogger(__name__)

DOCX_MAGIC = b"PK\x03\x04"
DOC_MAGIC = b"\xd0\xcf\x11\xe0"
WORD_XML_NS = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}


@dataclass
class OfficeTextExtraction:
    """Structured result of direct office document text extraction."""
    full_text: str
    lines: list[dict[str, Any]]
    char_count: int
    line_count: int
    elapsed_ms: int
    format: str


def extract_docx_text_from_bytes(file_bytes: bytes) -> OfficeTextExtraction:
    """Extract clean structured paragraphs and tables from a DOCX file using
    Python standard library zipfile and xml.etree.ElementTree (0 external dependencies).
    """
    t0 = time.monotonic()
    if not file_bytes:
        return OfficeTextExtraction("", [], 0, 0, 0, "docx")

    raw_lines: list[str] = []

    try:
        with zipfile.ZipFile(io.BytesIO(file_bytes)) as zf:
            if "word/document.xml" not in zf.namelist():
                raise ValueError("word/document.xml not found in DOCX archive")

            xml_data = zf.read("word/document.xml")
            tree = ET.fromstring(xml_data)

            # Find body element
            body = tree.find(".//w:body", WORD_XML_NS)
            if body is None:
                body = tree

            for child in body:
                tag = child.tag.split("}")[-1] if "}" in child.tag else child.tag

                if tag == "p":
                    # Normal paragraph
                    para_texts = [
                        t.text
                        for t in child.iterfind(".//w:t", WORD_XML_NS)
                        if t.text
                    ]
                    line = "".join(para_texts).strip()
                    if line:
                        raw_lines.append(line)

                elif tag == "tbl":
                    # Table element: format rows and cells
                    for tr in child.iterfind(".//w:tr", WORD_XML_NS):
                        row_cells: list[str] = []
                        for tc in tr.iterfind(".//w:tc", WORD_XML_NS):
                            cell_parts: list[str] = []
                            for p in tc.iterfind(".//w:p", WORD_XML_NS):
                                p_text = "".join(
                                    t.text
                                    for t in p.iterfind(".//w:t", WORD_XML_NS)
                                    if t.text
                                ).strip()
                                if p_text:
                                    cell_parts.append(p_text)
                            row_cells.append(" ".join(cell_parts).strip())
                        if any(row_cells):
                            raw_lines.append(" | ".join(row_cells))

    except Exception as exc:
        logger.warning("DOCX extraction error: %s", exc)
        raise

    full_text = "\n".join(raw_lines).strip()
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    lines_data = [
        {"text": line, "confidence": 1.0}
        for line in raw_lines
        if line.strip()
    ]

    return OfficeTextExtraction(
        full_text=full_text,
        lines=lines_data,
        char_count=len(full_text),
        line_count=len(lines_data),
        elapsed_ms=elapsed_ms,
        format="docx",
    )


def extract_doc_text_from_bytes(file_bytes: bytes) -> OfficeTextExtraction:
    """Extract readable text runs from legacy binary DOC (Word 97-2003) files."""
    t0 = time.monotonic()
    if not file_bytes:
        return OfficeTextExtraction("", [], 0, 0, 0, "doc")

    raw_lines: list[str] = []

    try:
        # Extract UTF-16LE runs (common in Word 97-2003 documents)
        utf16_runs = re.findall(b"(?:[\x20-\x7E\r\n\t][\x00]){4,}", file_bytes)
        for run in utf16_runs:
            try:
                decoded = run.decode("utf-16le", errors="ignore").strip()
                # Exclude internal binary headers and junk
                if len(decoded) >= 4 and not decoded.startswith(("WordDocument", "CompObj", "Root Entry")):
                    for subline in decoded.splitlines():
                        sub = subline.strip()
                        if len(sub) >= 2:
                            raw_lines.append(sub)
            except Exception:
                continue

        # If UTF-16LE yielded little or no text, fallback to ASCII runs
        if not raw_lines or sum(len(l) for l in raw_lines) < 30:
            ascii_runs = re.findall(rb"[\x20-\x7E\r\n\t]{4,}", file_bytes)
            for run in ascii_runs:
                try:
                    decoded = run.decode("ascii", errors="ignore").strip()
                    if len(decoded) >= 4 and not decoded.startswith(("WordDocument", "CompObj", "Root Entry")):
                        for subline in decoded.splitlines():
                            sub = subline.strip()
                            if len(sub) >= 2:
                                raw_lines.append(sub)
                except Exception:
                    continue

    except Exception as exc:
        logger.warning("DOC legacy binary extraction error: %s", exc)
        raise

    full_text = "\n".join(raw_lines).strip()
    elapsed_ms = int((time.monotonic() - t0) * 1000)

    lines_data = [
        {"text": line, "confidence": 1.0}
        for line in raw_lines
        if line.strip()
    ]

    return OfficeTextExtraction(
        full_text=full_text,
        lines=lines_data,
        char_count=len(full_text),
        line_count=len(lines_data),
        elapsed_ms=elapsed_ms,
        format="doc",
    )


def try_extract_office_text_from_bytes(
    file_bytes: bytes,
    filename: str = "",
) -> OfficeTextExtraction | None:
    """Inspect and extract office document text if file is DOCX or DOC.
    Returns None if file is not an office document.
    """
    ext = filename.lower().split(".")[-1] if "." in filename else ""

    is_docx = ext == "docx" or file_bytes.startswith(DOCX_MAGIC)
    if is_docx:
        try:
            return extract_docx_text_from_bytes(file_bytes)
        except Exception as exc:
            logger.warning("Failed direct DOCX text extraction: %s", exc)
            return None

    is_doc = ext == "doc" or file_bytes.startswith(DOC_MAGIC)
    if is_doc:
        try:
            return extract_doc_text_from_bytes(file_bytes)
        except Exception as exc:
            logger.warning("Failed direct DOC text extraction: %s", exc)
            return None

    return None
