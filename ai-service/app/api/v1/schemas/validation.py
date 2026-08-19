from __future__ import annotations

from pydantic import BaseModel, Field


class MedicalValidationRequest(BaseModel):
    bucket: str | None = None
    file_key: str = Field(alias="fileKey")
    mime_type: str | None = Field(default=None, alias="mimeType")
    max_pages: int | None = Field(default=None, alias="maxPages")
    trace_id: str | None = Field(default=None, alias="traceId")
    text: str | None = None

    class Config:
        populate_by_name = True


class ValidationMetrics(BaseModel):
    processing_seconds: float
    pages_used: int
    used_ollama: bool


class MedicalValidationResponse(BaseModel):
    isMedical: bool
    confidence: float
    documentType: str | None = None
    reason: str | None = None
    method: str
    model: str
    metrics: ValidationMetrics
