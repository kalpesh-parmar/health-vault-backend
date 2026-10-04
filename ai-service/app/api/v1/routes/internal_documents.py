from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status

from app.core.security import verify_internal_key
from app.infrastructure.db.repositories.job_repository import JobRepository
from app.infrastructure.db.session import Database
from app.schemas.internal_contracts import DocumentProcessRequest, ProcessInitiateResponse
from app.settings import Settings, get_settings
from app.workers.dispatch_queue import get_dispatch_queue

router = APIRouter(prefix="/internal/documents", tags=["internal-documents"])


def get_db(settings: Settings = Depends(get_settings)) -> Database:
    return Database(settings.database_url)


@router.post(
    "/process",
    response_model=ProcessInitiateResponse,
    status_code=status.HTTP_202_ACCEPTED,
)
async def process_document(
    request: DocumentProcessRequest,
    response: Response,
    _auth: str = Depends(verify_internal_key),
    settings: Settings = Depends(get_settings),
) -> ProcessInitiateResponse:
    db = Database(settings.database_url)
    repo = JobRepository(db)
    job = await repo.get_job_by_id(request.jobId)

    if not job:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Document processing job with ID {request.jobId} not found",
        )

    current_status = job.get("status")

    if current_status == "COMPLETED":
        response.status_code = status.HTTP_200_OK
        return ProcessInitiateResponse(jobId=request.jobId, status="COMPLETED")

    if current_status == "RUNNING":
        return ProcessInitiateResponse(jobId=request.jobId, status="RUNNING")

    # If QUEUED, place in local dispatch queue for low-latency wake up
    dispatch_queue = get_dispatch_queue()
    await dispatch_queue.put(request.jobId)

    return ProcessInitiateResponse(jobId=request.jobId, status="QUEUED")
