from __future__ import annotations

import logging

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


class OcrEmptyResultError(AiServiceError):
    """Raised when OCR completes but produced no text on any processed page.

    Mapped to HTTP 422 so callers receive an explicit failure instead of a
    misleading ``success=true`` response with empty content.
    """

    status_code = 422
    code = "ocr_empty_result"


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
