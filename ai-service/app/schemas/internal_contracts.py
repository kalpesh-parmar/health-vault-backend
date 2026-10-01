from __future__ import annotations

from typing import Literal
from uuid import UUID
from pydantic import BaseModel, Field


class StoragePointer(BaseModel):
    bucket: str
    key: str
    sha256: str


class DocumentProcessRequest(BaseModel):
    jobId: UUID
    patientId: UUID
    documentId: UUID
    storage: StoragePointer
    documentType: str | None = None
    preferredLanguage: str = "en"
    resumeFromStage: str | None = None


class ProcessInitiateResponse(BaseModel):
    jobId: UUID
    status: Literal["QUEUED", "RUNNING", "COMPLETED"]


class ProgressPageInfo(BaseModel):
    done: int
    total: int


class InnerProgressEvent(BaseModel):
    jobId: str
    fileKey: str
    documentId: str | None = None
    batchId: str | None = None
    stage: str
    stageStatus: str
    progress: int
    percentage: int
    status: str = "SUCCESS"
    message: str
    page: ProgressPageInfo | None = None
    detectedLanguages: list[str] = Field(default_factory=list)
    timestamp: str


class SseWireEnvelope(BaseModel):
    channelKey: str
    event: InnerProgressEvent
