from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.notifier import MAX_PG_NOTIFY_BYTES, ProgressNotifier


@pytest.mark.asyncio
async def test_publish_formats_exact_envelope_for_node_shared_sse_bus():
    db = MagicMock()
    mock_session = AsyncMock()
    
    async def mock_session_gen():
        yield mock_session

    db.session = mock_session_gen
    notifier = ProgressNotifier(db, channel="health_vault_sse_events")

    job_id = uuid.uuid4()
    file_key = "patient/123/doc.pdf"

    payload_str = await notifier.publish_progress(
        job_id=job_id,
        file_key=file_key,
        stage="OCR_RUNNING",
        stage_status="IN_PROGRESS",
        progress=42,
        percentage=42,
        message="Extracting page 3 of 7",
        page=3,
        total_pages=7,
        detected_languages=["gu", "en"],
    )

    data = json.loads(payload_str)
    # Node sharedSseBus expectations
    assert "channelKey" in data
    assert data["channelKey"] == file_key
    assert "event" in data

    event = data["event"]
    assert event["jobId"] == str(job_id)
    assert event["fileKey"] == file_key
    assert event["stage"] == "OCR_RUNNING"
    assert event["stageStatus"] == "IN_PROGRESS"
    assert event["progress"] == 42
    assert event["percentage"] == 42
    assert event["status"] == "SUCCESS"
    assert event["message"] == "Extracting page 3 of 7"
    assert event["page"] == {"done": 3, "total": 7}
    assert event["detectedLanguages"] == ["gu", "en"]
    assert "timestamp" in event

    # Check pg_notify invocation
    mock_session.execute.assert_awaited_once()
    call_args = mock_session.execute.call_args[0]
    sql_text = str(call_args[0])
    params = call_args[1]
    assert "pg_notify" in sql_text
    assert params["channel"] == "health_vault_sse_events"
    assert params["payload"] == payload_str


@pytest.mark.asyncio
async def test_publish_truncates_message_to_stay_under_7500_bytes():
    db = MagicMock()
    mock_session = AsyncMock()

    async def mock_session_gen():
        yield mock_session

    db.session = mock_session_gen
    notifier = ProgressNotifier(db)

    job_id = uuid.uuid4()
    file_key = "patient/123/doc.pdf"
    # Create massive 10KB message string
    oversized_message = "A" * 10000

    payload_str = await notifier.publish_progress(
        job_id=job_id,
        file_key=file_key,
        stage="OCR_RUNNING",
        stage_status="IN_PROGRESS",
        progress=50,
        percentage=50,
        message=oversized_message,
    )

    payload_bytes = payload_str.encode("utf-8")
    assert len(payload_bytes) <= MAX_PG_NOTIFY_BYTES

    # Check that it's still valid JSON
    data = json.loads(payload_str)
    assert data["event"]["message"].endswith("...")


def test_publish_strictly_rejects_phi_keys():
    db = MagicMock()
    notifier = ProgressNotifier(db)
    job_id = uuid.uuid4()
    file_key = "patient/123/doc.pdf"

    # Attempting to include patient diagnosis or clinical text should raise ValueError
    with pytest.raises(ValueError) as exc_info:
        notifier.build_envelope(
            job_id=job_id,
            file_key=file_key,
            stage="ANALYZING",
            stage_status="IN_PROGRESS",
            progress=80,
            percentage=80,
            message="Analysis completed",
            extra_fields={"diagnosis": "Acute Bronchitis", "patientName": "John Doe"},
        )

    assert "PHI violation" in str(exc_info.value)
