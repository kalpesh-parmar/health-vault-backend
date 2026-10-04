from __future__ import annotations

import io
import zipfile
import pytest

from app.modules.file_processing.office_text import (
    extract_docx_text_from_bytes,
    extract_doc_text_from_bytes,
    try_extract_office_text_from_bytes,
)


def _create_sample_docx() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        sample_xml = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p>
      <w:r><w:t>Patient Name: Rajesh Sharma</w:t></w:r>
    </w:p>
    <w:p>
      <w:r><w:t>Diagnosis: Acute Bronchitis</w:t></w:r>
    </w:p>
    <w:tbl>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Medicine</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Dosage</w:t></w:r></w:p></w:tc>
      </w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>Azithromycin 500mg</w:t></w:r></w:p></w:tc>
        <w:tc><w:p><w:r><w:t>Once Daily x 3 days</w:t></w:r></w:p></w:tc>
      </w:tr>
    </w:tbl>
    <w:p>
      <w:r><w:t>Follow up after 5 days.</w:t></w:r>
    </w:p>
  </w:body>
</w:document>"""
        zf.writestr("word/document.xml", sample_xml.encode("utf-8"))
    return buf.getvalue()


def test_extract_docx_text_success():
    docx_bytes = _create_sample_docx()
    result = extract_docx_text_from_bytes(docx_bytes)

    assert result.format == "docx"
    assert result.char_count > 0
    assert "Rajesh Sharma" in result.full_text
    assert "Acute Bronchitis" in result.full_text
    assert "Azithromycin 500mg | Once Daily x 3 days" in result.full_text
    assert "Follow up after 5 days." in result.full_text
    assert all(l["confidence"] == 1.0 for l in result.lines)


def test_try_extract_office_text_with_docx():
    docx_bytes = _create_sample_docx()
    result = try_extract_office_text_from_bytes(docx_bytes, filename="prescription.docx")

    assert result is not None
    assert result.format == "docx"
    assert "Rajesh Sharma" in result.full_text


def test_try_extract_office_text_rejects_non_office():
    non_office = b"%PDF-1.4 Fake PDF Header"
    assert try_extract_office_text_from_bytes(non_office, filename="test.pdf") is None

    image_data = b"\x89PNG\r\n\x1a\nFake PNG"
    assert try_extract_office_text_from_bytes(image_data, filename="test.png") is None


def test_extract_doc_text_with_utf16_runs():
    header = b"\xd0\xcf\x11\xe0"
    content = "Patient Name: Amit Patel\nPrescription: Paracetamol 650mg\n".encode("utf-16le")
    doc_bytes = header + content

    result = extract_doc_text_from_bytes(doc_bytes)
    assert result.format == "doc"
    assert "Amit Patel" in result.full_text
    assert "Paracetamol 650mg" in result.full_text
