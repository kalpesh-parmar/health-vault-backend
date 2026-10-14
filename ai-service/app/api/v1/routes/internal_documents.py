from __future__ import annotations

import time
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
    t0 = time.perf_counter()
    print(f"\n[PYTHON TIMING] [POST /internal/documents/process] START (jobId={request.jobId})", flush=True)
    db = Database(settings.database_url)
    repo = JobRepository(db)
    t_get_start = time.perf_counter()
    job = await repo.get_job_by_id(request.jobId)
    t_get_elapsed = (time.perf_counter() - t_get_start) * 1000
    print(f"  [PYTHON TIMING] repo.get_job_by_id took {t_get_elapsed:.2f}ms", flush=True)

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
    t_q_start = time.perf_counter()
    dispatch_queue = get_dispatch_queue()
    await dispatch_queue.put(request.jobId)
    t_q_elapsed = (time.perf_counter() - t_q_start) * 1000
    print(f"  [PYTHON TIMING] dispatch_queue.put took {t_q_elapsed:.2f}ms", flush=True)
    print(f"[PYTHON TIMING] [POST /internal/documents/process] TOTAL END: {(time.perf_counter() - t0)*1000:.2f}ms\n", flush=True)

    return ProcessInitiateResponse(jobId=request.jobId, status="QUEUED")
