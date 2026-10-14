from __future__ import annotations

import logging
import re
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import ValidationError as PydanticValidationError

logger = logging.getLogger(__name__)


class AiServiceError(Exception):
    status_code = 500
    code = "ai_service_error"

    def __init__(self, message: str, *, details: dict | None = None) -> None:
        super().__init__(message)
        self.message = message
        self.details = details or {}


class NotFoundError(AiServiceError):
    status_code = 404
    code = "not_found"


class ValidationError(AiServiceError):
    status_code = 400
    code = "validation_error"


class ModelUnavailableError(AiServiceError):
    status_code = 503
    code = "model_unavailable"


class TranslationError(AiServiceError):
    """Raised when language translation fails."""

    status_code = 502
    code = "translation_error"


class OcrEmptyResultError(AiServiceError):
    """Raised when OCR completes but produced no text on any processed page.

    Mapped to HTTP 422 so callers receive an explicit failure instead of a
    misleading ``success=true`` response with empty content.
    """

    status_code = 422
    code = "ocr_empty_result"


class NonMedicalDocumentException(AiServiceError):
    """Raised when a non-medical document (e.g. utility bill, invoice, receipt) is uploaded."""

    status_code = 400
    code = "non_medical_document"


class StageExecutionError(AiServiceError):
    """Raised when a pipeline stage execution fails."""

    status_code = 500
    code = "stage_execution_error"

    def __init__(
        self,
        message: str,
        stage: str | None = None,
        *,
        code: str | None = None,
        error_code: str | None = None,
        failed_stage: str | None = None,
        retryable: bool = True,
        requires_reupload: bool = False,
        details: dict | None = None,
        stage_details: dict | None = None,
    ) -> None:
        effective_details = stage_details if stage_details is not None else (details or {})
        super().__init__(message, details=effective_details)
        self.stage = failed_stage or stage or "UNKNOWN"
        self.failed_stage = self.stage
        self.code = error_code or code or self.code
        self.error_code = self.code
        self.retryable = retryable
        self.requires_reupload = requires_reupload
        self.stage_details = effective_details


class OcrStageFailureError(StageExecutionError):
    """Raised when OCR stage fails (e.g. all engines fail or unreadable placeholders detected)."""

    status_code = 422
    code = "ocr_failed"

    def __init__(
        self,
        message: str = "OCR text extraction failed",
        stage: str | None = None,
        *,
        code: str | None = None,
        error_code: str | None = None,
        failed_stage: str | None = None,
        retryable: bool = True,
        requires_reupload: bool = False,
        details: dict | None = None,
        stage_details: dict | None = None,
    ) -> None:
        super().__init__(
            message,
            stage=stage or "OCR_RUNNING",
            code=code or self.code,
            error_code=error_code,
            failed_stage=failed_stage,
            retryable=retryable,
            requires_reupload=requires_reupload,
            details=details,
            stage_details=stage_details,
        )


def install_exception_handlers(app: FastAPI) -> None:
    @app.exception_handler(AiServiceError)
    async def handle_ai_error(request: Request, exc: AiServiceError) -> JSONResponse:
        logger.error(
            "ai_service_error",
            extra={
                "path": request.url.path,
                "status_code": exc.status_code,
                "code": exc.code,
                "details": exc.details,
            },
            exc_info=(type(exc), exc, exc.__traceback__),
        )
        return JSONResponse(
            status_code=exc.status_code,
            content={"success": False, "error": exc.message, "code": exc.code, "details": exc.details},
        )

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation(request: Request, exc: RequestValidationError) -> JSONResponse:
        logger.warning("request_validation_error", extra={"path": request.url.path, "errors": exc.errors()})
        return JSONResponse(
            status_code=422,
            content={"success": False, "error": "Request validation failed", "code": "validation_error", "details": exc.errors()},
        )

    @app.exception_handler(PydanticValidationError)
    async def handle_pydantic_validation(request: Request, exc: PydanticValidationError) -> JSONResponse:
        logger.warning("pydantic_validation_error", extra={"path": request.url.path, "errors": exc.errors()})
        return JSONResponse(
            status_code=422,
            content={"success": False, "error": "Validation failed", "code": "validation_error", "details": exc.errors()},
        )

    @app.exception_handler(Exception)
    async def handle_unexpected(request: Request, exc: Exception) -> JSONResponse:
        logger.exception("Unhandled exception in request: %s", exc, extra={"path": request.url.path})
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": str(exc), "code": "internal_error"},
        )


_PATH_PATTERN = re.compile(
    r'(?:[a-zA-Z]:\\(?:[^\s\\/:*?"<>|\r\n]+\\)*[^\s\\/:*?"<>|\r\n]+)|(?:/(?:[^\s/\0]+(?:/)?)+)',
    re.UNICODE,
)


def sanitize_pipeline_error(exc: Any) -> str:
    """Sanitizes an exception or error string for persistence and client notification.

    - Database errors map to a short code ('DATABASE_ERROR') with no SQL or parameter leakage.
    - Other errors have local filesystem paths stripped and are capped at 255 characters.
    - Guarantees that neither '[SQL:' nor '[parameters:' ever appear in output.
    """
    if exc is None:
        return "UNKNOWN_ERROR"

    raw_str = str(exc) if not isinstance(exc, str) else exc
    exc_type_name = type(exc).__name__ if isinstance(exc, Exception) else ""
    mod_name = getattr(type(exc), "__module__", "")

    # Check for DB / SQL markers
    is_db_error = False
    if "sqlalchemy" in mod_name or "asyncpg" in mod_name or "psycopg" in mod_name:
        is_db_error = True
    elif exc_type_name in (
        "DBAPIError",
        "ProgrammingError",
        "OperationalError",
        "StatementError",
        "PostgresError",
        "PostgresSyntaxError",
        "AmbiguousParameterError",
        "IntegrityError",
    ):
        is_db_error = True

    if (
        is_db_error
        or "[SQL:" in raw_str
        or "[parameters:" in raw_str
        or "asyncpg." in raw_str
        or "sqlalchemy." in raw_str
        or "could not determine data type of parameter" in raw_str
        or "syntax error at or near" in raw_str
    ):
        return "DATABASE_ERROR"

    # For other errors, strip filesystem paths
    cleaned = _PATH_PATTERN.sub("<path>", raw_str)
    # Collapse multiple whitespace/newlines
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    if not cleaned:
        cleaned = "STAGE_EXECUTION_FAILED"

    # Cap at 255 characters
    return cleaned[:255]
