from __future__ import annotations

import asyncio
import logging

import pytest

from app.core.logging import (
    _RESERVED_LOG_RECORD_KEYS,
    _install_safe_make_record,
    sanitize_log_extra,
)
from app.modules.documents.service import DocumentAiService


class _FakeOcr:
    """Minimal OCR stand-in returning a fixed extraction payload."""

    def status(self) -> dict:
        return {"engine": "fake"}

    async def extract_document_bytes(self, *, document_bytes, filename, mime_type) -> dict:
        return {
            "pages": [{"page": 1, "text": "Glucose 92 mg/dL"}],
            "text": "Glucose 92 mg/dL",
            "fullText": "Glucose 92 mg/dL",
            "confidence": 0.9,
            "pageCount": 1,
            "processedPageCount": 1,
            "metrics": {"used_direct_text": True, "used_ocr": False},
        }


class _FakeSummary:
    async def summarize(self, text, *, mode, document_type) -> dict:
        return {"type": document_type, "mode": mode, "summary": [text]}


def test_sanitize_renames_all_reserved_keys() -> None:
    payload = {key: key for key in _RESERVED_LOG_RECORD_KEYS}
    payload["safe_key"] = "kept"
    sanitized = sanitize_log_extra(payload)
    assert sanitized["safe_key"] == "kept"
    # Not a single reserved key survives unprefixed.
    assert not (_RESERVED_LOG_RECORD_KEYS & set(sanitized.keys()))


def test_sanitize_handles_empty_and_none() -> None:
    assert sanitize_log_extra(None) == {}
    assert sanitize_log_extra({}) == {}


def test_make_record_guard_does_not_crash_on_reserved_keys(caplog: pytest.LogCaptureFixture) -> None:
    _install_safe_make_record()
    logger = logging.getLogger("test.guard")
    with caplog.at_level(logging.INFO):
        # Every one of these was previously fatal (KeyError in makeRecord).
        logger.info(
            "boom",
            extra={"filename": "a.pdf", "module": "m", "lineno": 7, "process": 1},
        )
    record = next(rec for rec in caplog.records if rec.getMessage() == "boom")
    assert getattr(record, "extra_filename") == "a.pdf"


def test_process_document_bytes_logs_without_keyerror(caplog: pytest.LogCaptureFixture) -> None:
    """Reproduces the production 500: INFO logging the document filename."""
    _install_safe_make_record()
    service = DocumentAiService(_FakeOcr(), _FakeSummary())
    with caplog.at_level(logging.INFO):
        result = asyncio.run(
            service.process_document_bytes(
                document_bytes=b"%PDF-1.4 fake",
                filename="patient-report.pdf",
                mime_type="application/pdf",
                mode="concise",
                document_type="medical",
            )
        )
    assert result["success"] is True
    # The "document_processed" log line carries the filename under a safe key
    # (`document_name`, since `filename` is a reserved LogRecord attribute).
    processing = next(
        rec for rec in caplog.records if rec.getMessage() == "document_processed"
    )
    assert getattr(processing, "document_name") == "patient-report.pdf"
    # Response metadata still exposes `filename` for backward compatibility.
    assert result["metadata"]["filename"] == "patient-report.pdf"
