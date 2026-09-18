from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel, Field

router = APIRouter(prefix="/extraction", tags=["extraction"])


class NormalizeRequest(BaseModel):
    structuredOcr: dict


class SummaryRequest(BaseModel):
    structuredDocument: dict
    patientContext: dict | str | None = None
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


class MedicalGraphModel(BaseModel):
    graphType: str = "unknown"
    title: str | None = None
    xAxis: list[Any] = Field(default_factory=list)
    yAxis: list[Any] = Field(default_factory=list)
    series: list[dict[str, Any]] = Field(default_factory=list)
    unit: str | None = None
    page: int | None = None
    metadata: dict[str, Any] = Field(default_factory=dict)


class GraphExtractionResponse(BaseModel):
    success: bool = True
    graphs: list[MedicalGraphModel]


@router.post("/graphs", response_model=GraphExtractionResponse)
async def extract_graphs(payload: GraphExtractionRequest, request: Request) -> GraphExtractionResponse:
    container = request.app.state.container
    graphs = await container.extraction.extract_graphs(payload.structuredDocument)
    return GraphExtractionResponse(success=True, graphs=graphs)