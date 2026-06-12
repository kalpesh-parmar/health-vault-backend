from __future__ import annotations

from fastapi import APIRouter, Request
from pydantic import BaseModel

router = APIRouter(prefix="/extraction", tags=["extraction"])


class NormalizeRequest(BaseModel):
    structuredOcr: dict


class SummaryRequest(BaseModel):
    structuredDocument: dict
    patientContext: dict | None = None
    medications: list[dict] = []
    medicalEntities: list[dict] = []


@router.post("/normalize")
async def normalize(payload: NormalizeRequest, request: Request) -> dict:
    data = await request.app.state.container.extraction.normalize_structured_ocr(payload.structuredOcr)
    return {"success": True, "data": data}


@router.post("/summarize")
async def summarize(payload: SummaryRequest, request: Request) -> dict:
    data = await request.app.state.container.extraction.summarize(
        payload.structuredDocument,
        payload.patientContext,
        payload.medications,
        payload.medicalEntities,
    )
    return {"success": True, "data": data}


class GraphExtractionRequest(BaseModel):
    structuredDocument: dict


@router.post("/graphs")
async def extract_graphs(payload: GraphExtractionRequest, request: Request) -> dict:
    container = request.app.state.container
    graphs = await container.extraction.extract_graphs(payload.structuredDocument)
    return {"success": True, "graphs": graphs}
