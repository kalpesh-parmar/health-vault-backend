from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import text

from app.infrastructure.db.session import Database
from app.schemas.internal_contracts import InnerProgressEvent, ProgressPageInfo, SseWireEnvelope

logger = logging.getLogger(__name__)

MAX_PG_NOTIFY_BYTES = 7500
DISALLOWED_PHI_FIELDS = {
    "patient_name",
    "patientName",
    "clinical_text",
    "clinicalText",
    "diagnosis",
    "findings",
    "medications",
    "raw_ocr",
    "rawOcr",
    "summary",
    "dob",
    "ssn",
    "address",
}


class ProgressNotifier:
    def __init__(self, db: Database, channel: str = "health_vault_sse_events") -> None:
        self.db = db
        self.channel = channel

    def build_envelope(
        self,
        job_id: UUID | str,
        file_key: str,
        stage: str,
        stage_status: str,
        progress: int,
        percentage: int,
        message: str,
        batch_id: str | None = None,
        document_id: UUID | str | None = None,
        page: int | None = None,
        total_pages: int | None = None,
        detected_languages: list[str] | None = None,
        extra_fields: dict[str, Any] | None = None,
    ) -> SseWireEnvelope:
        # Zero-PHI safety check: ensure no extra fields leak PHI
        if extra_fields:
            for key in extra_fields:
                if key.lower() in {k.lower() for k in DISALLOWED_PHI_FIELDS}:
                    raise ValueError(f"PHI violation: disallowed field '{key}' detected in progress event")

        page_info = None
        if page is not None and total_pages is not None:
            page_info = ProgressPageInfo(done=page, total=total_pages)

        now_iso = datetime.now(timezone.utc).isoformat()

        event = InnerProgressEvent(
            jobId=str(job_id),
            fileKey=file_key,
            documentId=str(document_id) if document_id else None,
            batchId=batch_id,
            stage=stage,
            stageStatus=stage_status,
            progress=int(progress),
            percentage=int(percentage),
            status="SUCCESS",
            message=message,
            page=page_info,
            detectedLanguages=detected_languages or [],
            timestamp=now_iso,
        )

        return SseWireEnvelope(channelKey=file_key, event=event)

    def serialize_and_truncate(self, envelope: SseWireEnvelope) -> str:
        payload_dict = envelope.model_dump(exclude_none=False)
        raw_json = json.dumps(payload_dict, separators=(",", ":"))
        raw_bytes = raw_json.encode("utf-8")

        if len(raw_bytes) <= MAX_PG_NOTIFY_BYTES:
            return raw_json

        # Truncate message field to fit within the 7500 byte limit
        excess = len(raw_bytes) - MAX_PG_NOTIFY_BYTES + 32
        current_msg = envelope.event.message
        if len(current_msg) > excess:
            truncated_msg = current_msg[:-excess] + "..."
        else:
            truncated_msg = current_msg[:20] + "..."

        envelope.event.message = truncated_msg
        payload_dict = envelope.model_dump(exclude_none=False)
        truncated_json = json.dumps(payload_dict, separators=(",", ":"))

        # Final safety guarantee
        if len(truncated_json.encode("utf-8")) > MAX_PG_NOTIFY_BYTES:
            envelope.event.message = "Progress updated"
            truncated_json = json.dumps(envelope.model_dump(exclude_none=False), separators=(",", ":"))

        return truncated_json

    async def publish_progress(
        self,
        job_id: UUID | str,
        file_key: str,
        stage: str,
        stage_status: str,
        progress: int,
        percentage: int,
        message: str,
        batch_id: str | None = None,
        document_id: UUID | str | None = None,
        page: int | None = None,
        total_pages: int | None = None,
        detected_languages: list[str] | None = None,
        extra_fields: dict[str, Any] | None = None,
    ) -> str:
        envelope = self.build_envelope(
            job_id=job_id,
            file_key=file_key,
            stage=stage,
            stage_status=stage_status,
            progress=progress,
            percentage=percentage,
            message=message,
            batch_id=batch_id,
            document_id=document_id,
            page=page,
            total_pages=total_pages,
            detected_languages=detected_languages,
            extra_fields=extra_fields,
        )

        serialized = self.serialize_and_truncate(envelope)

        notify_query = text("SELECT pg_notify(:channel, :payload)")
        async for session in self.db.session():
            await session.execute(notify_query, {"channel": self.channel, "payload": serialized})
            await session.commit()

        return serialized
