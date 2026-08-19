from __future__ import annotations

import logging
import uuid
from typing import Any

from fastapi import APIRouter, File, HTTPException, Request, UploadFile, status

from app.api.v1.schemas.validation import MedicalValidationResponse
from app.modules.validation.service import (
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
) -> Any:
    """Validate whether an uploaded document is a genuine medical report."""
    trace_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    container = request.app.state.container
    service = MedicalValidationService(container.settings, container.storage)

    try:
        content = await file.read()
        if not content or len(content) == 0:
            raise InvalidDocumentFileError("Uploaded file is empty")

        result = await service.validate_medical_document(
            file_bytes=content,
            file_name=file.filename,
            mime_type=file.content_type,
            trace_id=trace_id,
        )
        return result
    except InvalidDocumentFileError as exc:
        logger.warning("Unreadable file in medical validation: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail={"code": "UNREADABLE_FILE", "message": str(exc)},
        ) from exc
    except MedGemmaUnavailableError as exc:
        logger.error("MedGemma unavailable: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail={"code": "MEDGEMMA_UNAVAILABLE", "message": str(exc)},
        ) from exc
    except Exception as exc:
        logger.error("Unexpected error in medical validation: %s", exc, exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail={"code": "INTERNAL_ERROR", "message": "Failed to validate document"},
        ) from exc
    finally:
        await file.close()

