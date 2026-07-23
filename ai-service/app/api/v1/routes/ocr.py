from __future__ import annotations

import logging
import time
import uuid

from fastapi import APIRouter, File, Form, Request, UploadFile
from fastapi.responses import JSONResponse

from app.api.v1.schemas.documents import DirectOcrRequest
from app.core.errors import AiServiceError

router = APIRouter(tags=["document-extraction"])
logger = logging.getLogger(__name__)


@router.post("/run-ocr", response_model=None)
async def run_ocr(
    request: Request,
    file: UploadFile | None = File(default=None),
    mode: str = Form(default="concise"),
    document_type: str = Form(default="medical"),
    slim: bool | None = Form(default=None),
) -> dict | JSONResponse:
    """Backward-compatible document extraction endpoint.

    OCR runs through the configured vision provider. The
    summary is derived from the same vision call when available, avoiding a
    second slow LLM round-trip. Pass `slim=true` (form field or `?slim=true`)
    for a minimal, de-duplicated payload.
    """

    started = time.monotonic()
    request_id = request.headers.get("x-request-id") or str(uuid.uuid4())
    container = request.app.state.container
    # Allow `?slim=true` as well as the multipart form field.
    if slim is None:
        query_slim = request.query_params.get("slim")
        if query_slim is not None:
            slim = query_slim.strip().lower() in ("1", "true", "yes")

    try:
        if file is not None:
            filename = file.filename or "document.pdf"
            read_started = time.monotonic()
            document_bytes = await file.read()
            file_read_ms = int((time.monotonic() - read_started) * 1000)
            result = await container.documents.process_document_bytes(
                document_bytes=document_bytes,
                filename=filename,
                mime_type=file.content_type,
                mode=mode,
                document_type=document_type,
                slim=slim,
            )
            result["requestId"] = request_id
            result.setdefault("timings", {})["fileReadMs"] = file_read_ms
            logger.info(
                "run_ocr_upload_done",
                extra={
                    "request_id": request_id,
                    "document_name": filename,
                    "bytes": len(document_bytes),
                    "file_read_ms": file_read_ms,
                    "elapsed_ms": int((time.monotonic() - started) * 1000),
                },
            )
            return result

        if "application/json" in request.headers.get("content-type", ""):
            body = await request.json()
            payload = DirectOcrRequest.model_validate(body)
            logger.info("run_ocr_json_payload", extra={"request_id": request_id, "bucket": payload.bucket, "file_key": payload.file_key, "mime_type": payload.mime_type})
            
            if slim is None and isinstance(body, dict) and body.get("slim") is not None:
                slim = bool(body.get("slim"))
            read_started = time.monotonic()
            
            try:
                document_bytes = await container.storage.read_bytes(
                    bucket=payload.bucket,
                    key=payload.file_key,
                )
                logger.info("run_ocr_storage_read_success", extra={"request_id": request_id, "bytes_length": len(document_bytes)})
            except Exception as e:
                logger.error("run_ocr_storage_read_failed", extra={"request_id": request_id, "error": str(e)}, exc_info=True)
                raise
                
            storage_read_ms = int((time.monotonic() - read_started) * 1000)
            result = await container.documents.process_document_bytes(
                document_bytes=document_bytes,
                filename=payload.file_key,
                mime_type=payload.mime_type,
                mode=mode,
                document_type=document_type,
                slim=slim,
            )
            result["requestId"] = request_id
            result.setdefault("timings", {})["storageReadMs"] = storage_read_ms
            logger.info(
                "run_ocr_storage_done",
                extra={
                    "request_id": request_id,
                    "bucket": payload.bucket,
                    "file_key": payload.file_key,
                    "bytes": len(document_bytes),
                    "storage_read_ms": storage_read_ms,
                    "elapsed_ms": int((time.monotonic() - started) * 1000),
                },
            )
            return result

        return JSONResponse(
            status_code=400,
            content={
                "success": False,
                "error": "Upload a PDF file or send a JSON storage payload",
            },
        )
    except AiServiceError:
        # Domain errors (e.g. empty-OCR rejection, model unavailable) carry
        # their own status code and are handled by the global exception
        # handler. Re-raise so the structured response is preserved.
        raise
    except ValueError as exc:
        logger.warning("run_ocr_invalid_request", extra={"request_id": request_id, "error": str(exc)})
        return JSONResponse(
            status_code=422,
            content={"success": False, "error": "Document extraction failed", "details": str(exc)},
        )
    except Exception as exc:
        logger.exception("run_ocr_failed", extra={"request_id": request_id})
        return JSONResponse(
            status_code=500,
            content={"success": False, "error": "Document extraction failed", "details": str(exc)},
        )


@router.post("/ocr/extract", response_model=None)
async def extract_ocr_alias(
    request: Request,
    file: UploadFile | None = File(default=None),
    mode: str = Form(default="concise"),
    document_type: str = Form(default="medical"),
) -> dict | JSONResponse:
    return await run_ocr(
        request,
        file=file,
        mode=mode,
        document_type=document_type,
    )
