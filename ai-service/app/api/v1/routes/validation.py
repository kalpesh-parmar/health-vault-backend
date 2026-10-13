from __future__ import annotations

import logging
import time
import uuid
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, Request, UploadFile, status

from app.api.v1.schemas.validation import MedicalValidationResponse
from app.modules.validation.service import (
    ClassifierUnavailableError,
    InvalidDocumentFileError,
    MedGemmaUnavailableError,
    MedicalValidationService,
)

router = APIRouter(tags=["medical-validation"])
logger = logging.getLogger(__name__)


@router.post(
    "/validation/medical",
    response_model=MedicalValidationResponse,
    status_code=status.HTTP_200_OK,
)
async def validate_medical(
    request: Request,
    file: UploadFile = File(...),
    maxPages: int | None = Form(None),
    max_pages: int | None = Form(None),
) -> Any:
    """Validate whether an uploaded document is a genuine medical report."""
    trace_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    container = request.app.state.container
    service = MedicalValidationService(container.settings, container.storage)
    effective_max_pages = maxPages if maxPages is not None else max_pages

    t_route_start = time.perf_counter()
    print(f"\n[PYTHON TIMING] [POST /v1/validation/medical] START (trace_id={trace_id})", flush=True)
    try:
        t_read_start = time.perf_counter()
        content = await file.read()
        t_read_elapsed = (time.perf_counter() - t_read_start) * 1000
        print(f"[PYTHON TIMING] file.read() took {t_read_elapsed:.2f}ms (size={len(content)} bytes)", flush=True)
        if not content or len(content) == 0:
            raise InvalidDocumentFileError("Uploaded file is empty")

        t_service_start = time.perf_counter()
        result = await service.validate_medical_document(
            file_bytes=content,
            file_name=file.filename,
            mime_type=file.content_type,
            max_pages=effective_max_pages,
            trace_id=trace_id,
        )
        t_service_elapsed = (time.perf_counter() - t_service_start) * 1000
        t_total_route_elapsed = (time.perf_counter() - t_route_start) * 1000
        print(f"[PYTHON TIMING] service.validate_medical_document took {t_service_elapsed:.2f}ms", flush=True)
        print(f"[PYTHON TIMING] [POST /v1/validation/medical] TOTAL END: {t_total_route_elapsed:.2f}ms (isMedical={result.isMedical})\n", flush=True)
        return result
    except InvalidDocumentFileError as exc:
        logger.warning("Unreadable file in medical validation: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "UNREADABLE_FILE", "message": str(exc)},
        ) from exc
    except (ClassifierUnavailableError, MedGemmaUnavailableError) as exc:
        logger.error("Medical validation classifier unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "CLASSIFIER_UNAVAILABLE", "alias": "MEDGEMMA_UNAVAILABLE", "message": str(exc)},
        ) from exc
    except Exception as exc:
        logger.error("Unexpected error in medical validation: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "INTERNAL_ERROR", "message": "Failed to validate document"},
        ) from exc
    finally:
        await file.close()