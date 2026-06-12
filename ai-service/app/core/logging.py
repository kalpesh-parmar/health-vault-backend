from __future__ import annotations

import logging
import sys

# Attributes the stdlib sets on every LogRecord. Passing any of these through
# `logging.*(..., extra={...})` raises `KeyError: "Attempt to overwrite ..."`
# inside `Logger.makeRecord`, which surfaces as an HTTP 500 at the call site.
# We snapshot a real record's attribute names plus the keys the stdlib guards
# explicitly (`message`, `asctime`) so the guard stays correct across Python
# versions (e.g. `taskName` was added in 3.12).
_RESERVED_LOG_RECORD_KEYS: frozenset[str] = frozenset(
    set(
        logging.LogRecord(
            name="",
            level=logging.INFO,
            pathname="",
            lineno=0,
            msg="",
            args=(),
            exc_info=None,
        ).__dict__.keys()
    )
    | {"message", "asctime"}
)

# Prefix applied to a colliding key so the value is preserved rather than
# dropped (e.g. `filename` -> `extra_filename`).
_SAFE_KEY_PREFIX = "extra_"


def sanitize_log_extra(extra: dict[str, object] | None) -> dict[str, object]:
    """Return a copy of ``extra`` with any reserved LogRecord keys renamed.

    Reserved keys are re-prefixed with ``extra_`` (re-prefixing again on the
    rare chance the prefixed name also collides) instead of being dropped, so
    no diagnostic context is lost.
    """
    if not extra:
        return {}
    sanitized: dict[str, object] = {}
    for key, value in extra.items():
        safe_key = key
        while safe_key in _RESERVED_LOG_RECORD_KEYS or (
            safe_key != key and safe_key in extra
        ):
            safe_key = f"{_SAFE_KEY_PREFIX}{safe_key}"
        sanitized[safe_key] = value
    return sanitized


def _install_safe_make_record() -> None:
    """Patch ``Logger.makeRecord`` to never crash on reserved-key clashes.

    The stdlib raises ``KeyError`` when an ``extra`` dict tries to overwrite a
    reserved attribute. A LogRecord factory cannot help here because it runs
    *before* ``extra`` is applied and never receives it. Wrapping
    ``makeRecord`` is the only interception point that sees ``extra`` ahead of
    the reserved-key check, so it guarantees that a single mislabelled logging
    call anywhere in the process can never return an HTTP 500.

    This is a safety net. Call sites should still use non-reserved key names;
    the wrapper simply renames offenders (and logs a one-time warning) instead
    of letting them propagate.
    """
    original_make_record = logging.Logger.makeRecord
    if getattr(original_make_record, "_health_vault_safe", False):
        return

    def safe_make_record(self, name, level, fn, lno, msg, args, exc_info,
                          func=None, extra=None, sinfo=None):
        if extra:
            collisions = [key for key in extra if key in _RESERVED_LOG_RECORD_KEYS]
            if collisions:
                extra = sanitize_log_extra(extra)
                logging.getLogger(__name__).warning(
                    "log_extra_reserved_keys_renamed",
                    extra={"reserved_keys": ",".join(sorted(collisions))},
                )
        return original_make_record(
            self, name, level, fn, lno, msg, args, exc_info, func, extra, sinfo
        )

    safe_make_record._health_vault_safe = True  # type: ignore[attr-defined]
    logging.Logger.makeRecord = safe_make_record  # type: ignore[assignment]


def configure_logging(level: str = "INFO") -> None:
    logging.basicConfig(
        level=getattr(logging, level.upper(), logging.INFO),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
        force=True,
    )
    _install_safe_make_record()
