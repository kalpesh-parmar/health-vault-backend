from __future__ import annotations

from fastapi import APIRouter, Request

from app.api.v1.schemas.summary import SummaryRequest

router = APIRouter(tags=["summary"])


@router.post("/summarize")
async def summarize(payload: SummaryRequest, request: Request) -> dict:
    summary = await request.app.state.container.summary.summarize(
        payload.text,
        mode=payload.mode,
        document_type=payload.document_type,
    )
    return {"success": True, "summary": summary}
