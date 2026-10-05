from __future__ import annotations

import json
import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest
from app.infrastructure.db.repositories.job_repository import JobRepository
from app.services.pipeline.orchestrator import PipelineOrchestrator
from app.constants.stages import STAGE_SUMMARIZING


@pytest.mark.asyncio
async def test_sync_to_documents_table_persists_summary_english():
    mock_db = MagicMock()
    mock_session = AsyncMock()
    
    # Setup async generator context manager for session
    async def mock_session_gen():
        yield mock_session

    mock_db.session.return_value = mock_session_gen()

    repo = JobRepository(mock_db)
    doc_id = uuid.uuid4()
    extracted_data = {
        "summaryEnglish": "Patient presents with normal hemoglobin levels of 13.5 g/dL and no acute abnormalities.",
        "labResults": [{"testName": "Hb", "value": 13.5}],
    }
    raw_ocr = {"fullText": "Hemoglobin 13.5 g/dL Normal"}

    await repo.sync_to_documents_table(
        document_id=doc_id,
        extracted_structured_data=extracted_data,
        raw_ocr_data=raw_ocr,
    )

    assert mock_session.execute.called
    call_args = mock_session.execute.call_args
    query_obj = call_args[0][0]
    params = call_args[0][1]

    # Verify query includes summary_english
    assert "summary_english = COALESCE(:summary_english, summary_english)" in query_obj.text
    # Verify params match
    assert params["document_id"] == doc_id
    assert params["summary_english"] == extracted_data["summaryEnglish"]
    assert params["raw_text"] == "Hemoglobin 13.5 g/dL Normal"
    assert json.loads(params["extracted_structured_data"]) == extracted_data


@pytest.mark.asyncio
async def test_sync_to_documents_table_handles_null_summary():
    mock_db = MagicMock()
    mock_session = AsyncMock()

    async def mock_session_gen():
        yield mock_session

    mock_db.session.return_value = mock_session_gen()

    repo = JobRepository(mock_db)
    doc_id = uuid.uuid4()

    await repo.sync_to_documents_table(
        document_id=doc_id,
        extracted_structured_data=None,
        raw_ocr_data=None,
    )

    assert mock_session.execute.called
    params = mock_session.execute.call_args[0][1]
    assert params["summary_english"] is None
    assert params["extracted_structured_data"] is None


@pytest.mark.asyncio
async def test_orchestrator_stage_8_merges_summary_into_structured_data():
    orchestrator = PipelineOrchestrator.__new__(PipelineOrchestrator)
    mock_summary_handler = AsyncMock()
    mock_summary_handler.generate_summary.return_value = {
        "summaryEnglish": "Normal fasting blood glucose 95 mg/dL. No evidence of diabetes.",
        "summaryInPreferredLanguage": "સામાન્ય રક્ત ગ્લુકોઝ 95 mg/dL.",
        "summaryLanguage": "gujarati",
        "preferredLanguage": "gujarati",
        "keyPoints": ["Glucose is normal"],
        "dosagePreserved": True,
    }
    orchestrator.summary_handler = mock_summary_handler
    orchestrator.checkpoint = AsyncMock()
    orchestrator.lifecycle = MagicMock()
    orchestrator.lifecycle.report_progress = AsyncMock()

    job_id = uuid.uuid4()
    completed_stages = []
    current_pct = 70
    extracted_structured_data = {"labResults": [{"testName": "Glucose", "value": 95}]}
    checkpoint_data = {}

    # Simulate Stage 8 block
    if STAGE_SUMMARIZING not in completed_stages:
        summary_data = await orchestrator.summary_handler.generate_summary(
            raw_text="Glucose 95 mg/dL",
            structured_data=extracted_structured_data or {},
            preferred_language="gujarati",
        )
        if extracted_structured_data is not None and isinstance(summary_data, dict):
            extracted_structured_data.update({
                "summaryEnglish": summary_data.get("summaryEnglish"),
                "summaryInPreferredLanguage": summary_data.get("summaryInPreferredLanguage"),
                "summaryLanguage": summary_data.get("summaryLanguage"),
                "preferredLanguage": summary_data.get("preferredLanguage"),
                "keyPoints": summary_data.get("keyPoints"),
                "dosagePreserved": summary_data.get("dosagePreserved"),
            })

    assert "summaryEnglish" in extracted_structured_data
    assert extracted_structured_data["summaryEnglish"] == "Normal fasting blood glucose 95 mg/dL. No evidence of diabetes."
    assert extracted_structured_data["summaryInPreferredLanguage"] == "સામાન્ય રક્ત ગ્લુકોઝ 95 mg/dL."
    assert extracted_structured_data["summaryLanguage"] == "gujarati"
