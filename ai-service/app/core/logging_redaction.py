from __future__ import annotations

import logging
from typing import Any

# Sensitive keys that must never appear unredacted in pipeline logs
REDACT_KEYS: frozenset[str] = frozenset({
    "buffer",
    "base64",
    "imageb64",
    "apikey",
    "authorization",
    "token",
    "secret",
    "password",
    "patientname",
    "patient_name",
    "name",
    "fullname",
    "firstname",
    "lastname",
    "middlename",
    "phone",
    "phonenumber",
    "mobile",
    "email",
    "caseid",
    "uhid",
    "mrn",
    "doctorname",
    "doctor_name",
    "referringdoctor",
    "rawtext",
    "raw_text",
    "fulltext",
    "ocrtext",
    "ocr_text",
    "extractedtext",
})


def redact_sensitive_data(data: Any) -> Any:
    """Recursively redact patient identifiers, credentials, and raw text from data structures."""
    if data is None:
        return None
    if isinstance(data, (int, float, bool)):
        return data
    if isinstance(data, str):
        return data
    if isinstance(data, list):
        return [redact_sensitive_data(item) for item in data]
    if isinstance(data, tuple):
        return tuple(redact_sensitive_data(item) for item in data)
    if isinstance(data, set):
        return {redact_sensitive_data(item) for item in data}
    if isinstance(data, dict):
        out: dict[str, Any] = {}
        for k, v in data.items():
            lower_k = str(k).lower().replace("-", "_")
            if (
                lower_k in REDACT_KEYS
                or "password" in lower_k
                or "secret" in lower_k
                or "token" in lower_k
            ):
                out[k] = "[redacted]"
            elif isinstance(v, str) and ("text" in lower_k and len(v) > 80):
                out[k] = f"[redacted text: {len(v)} chars]"
            elif isinstance(v, str) and len(v) > 500:
                out[k] = f"{v[:500]}…[+{len(v) - 500} chars]"
            elif isinstance(v, (dict, list, tuple, set)):
                out[k] = redact_sensitive_data(v)
            else:
                out[k] = v
        return out
    return data


class RedactingLoggingFilter(logging.Filter):
    """Logging filter that sanitizes record args and extra fields to prevent accidental PHI leaks."""

    def filter(self, record: logging.LogRecord) -> bool:
        if isinstance(record.args, dict):
            record.args = redact_sensitive_data(record.args)
        elif isinstance(record.args, tuple):
            record.args = tuple(redact_sensitive_data(a) for a in record.args)
        return True
