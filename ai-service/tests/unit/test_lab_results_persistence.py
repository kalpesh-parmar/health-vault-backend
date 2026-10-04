from __future__ import annotations

import uuid
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
import pytest

from app.infrastructure.db.models import PatientLabResult
from app.infrastructure.db.repositories.lab_result_repository import (
    LabResultRepository,
    _parse_datetime,
)
from app.services.pipeline.orchestrator import PipelineOrchestrator


def test_parse_datetime_variants():
    # ISO 8601 with Z
    dt1 = _parse_datetime("2026-08-15T10:30:00Z")
    assert dt1 is not None
    assert dt1.year == 2026 and dt1.month == 8 and dt1.day == 15
    assert dt1.tzinfo == timezone.utc

    # YYYY-MM-DD
    dt2 = _parse_datetime("2025-12-01")
    assert dt2 is not None
    assert dt2.year == 2025 and dt2.month == 12 and dt2.day == 1

    # DD/MM/YYYY
    dt3 = _parse_datetime("25/06/2024")
    assert dt3 is not None
    assert dt3.year == 2024 and dt3.month == 6 and dt3.day == 25

    # Empty / None
    assert _parse_datetime(None) is None
    assert _parse_datetime("") is None
    assert _parse_datetime("   ") is None
    assert _parse_datetime("not-a-valid-date") is None


@pytest.mark.asyncio
async def test_persist_lab_results_normalizes_and_deletes_prior():
    user_id = uuid.uuid4()
    document_id = uuid.uuid4()
    mock_session = AsyncMock()
    mock_session.add = MagicMock()
    mock_session.execute = AsyncMock()
    mock_session.commit = AsyncMock()

    repo = LabResultRepository(session=mock_session)

    lab_items = [
        {
            "testName": "Fasting Blood Sugar",
            "value": 145.0,
            "unit": "mg/dL",
            "pageNo": 1,
            "confidence": 0.95,
            "provenance": "paddle_ocr",
            "verification_required": False,
        },
        {
            "testName": "HbA1c",
            "value": "11.2",
            "unit": "%",
            "pageNo": 2,
            "confidence": 0.92,
        },
    ]

    persisted = await repo.persist_lab_results(
        user_id=user_id,
        document_id=document_id,
        report_id="job_report_123",
        lab_items=lab_items,
        test_date="2026-05-10",
    )

    # 1. Verify delete was called on session for idempotency
    assert mock_session.execute.called
    assert mock_session.commit.called

    # 2. Verify 2 items were added to session
    assert mock_session.add.call_count == 2
    added_entities: list[PatientLabResult] = [call.args[0] for call in mock_session.add.call_args_list]

    # Verify first entity (FBS)
    fbs = added_entities[0]
    assert fbs.canonical_key == "fasting_blood_glucose"
    assert fbs.test_name == "Fasting Blood Sugar"
    assert fbs.value_numeric == 145.0
    assert fbs.flag == "HIGH"
    assert fbs.is_abnormal is True
    assert fbs.is_critical is False
    assert fbs.page_no == 1
    assert fbs.confidence == 0.95
    assert fbs.test_date == datetime(2026, 5, 10, tzinfo=timezone.utc)
    assert fbs.metadata_.get("provenance") == "paddle_ocr"

    # Verify second entity (HbA1c critical high)
    hba1c = added_entities[1]
    assert hba1c.canonical_key == "hba1c"
    assert hba1c.value_numeric == 11.2
    assert hba1c.flag == "CRITICAL"
    assert hba1c.is_abnormal is True
    assert hba1c.is_critical is True
    assert hba1c.page_no == 2

    # 3. Check returned dictionaries
    assert len(persisted) == 2
    assert persisted[0]["canonicalKey"] == "fasting_blood_glucose"
    assert persisted[0]["flag"] == "HIGH"
    assert persisted[1]["canonicalKey"] == "hba1c"
    assert persisted[1]["flag"] == "CRITICAL"


@pytest.mark.asyncio
async def test_persist_lab_results_empty_list_cleans_up():
    user_id = uuid.uuid4()
    document_id = uuid.uuid4()
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock()
    mock_session.commit = AsyncMock()

    repo = LabResultRepository(session=mock_session)

    res = await repo.persist_lab_results(
        user_id=user_id,
        document_id=document_id,
        lab_items=[],
    )

    assert res == []
    assert mock_session.execute.called
    assert mock_session.commit.called


@pytest.mark.asyncio
async def test_query_longitudinal():
    user_id = uuid.uuid4()
    canonical_key = "fasting_blood_glucose"

    row1 = {
        "id": uuid.uuid4(),
        "user_id": user_id,
        "document_id": uuid.uuid4(),
        "report_id": "rep_1",
        "canonical_key": canonical_key,
        "test_name": "Fasting Blood Glucose",
        "value_numeric": 110.0,
        "value_text": "110",
        "unit": "mg/dL",
        "reference_range": "70.0 - 99.0 mg/dL",
        "flag": "HIGH",
        "is_abnormal": True,
        "is_critical": False,
        "test_date": datetime(2026, 4, 1, tzinfo=timezone.utc),
        "page_no": 1,
        "confidence": 0.98,
        "metadata": {"provenance": "primary_ocr"},
        "created_at": datetime(2026, 4, 1, 10, 0, 0, tzinfo=timezone.utc),
    }
    row2 = {
        "id": uuid.uuid4(),
        "user_id": user_id,
        "document_id": uuid.uuid4(),
        "report_id": "rep_2",
        "canonical_key": canonical_key,
        "test_name": "FBS",
        "value_numeric": 95.0,
        "value_text": "95",
        "unit": "mg/dL",
        "reference_range": "70.0 - 99.0 mg/dL",
        "flag": "NORMAL",
        "is_abnormal": False,
        "is_critical": False,
        "test_date": datetime(2026, 1, 15, tzinfo=timezone.utc),
        "page_no": 1,
        "confidence": 0.94,
        "metadata": {"provenance": "primary_ocr"},
        "created_at": datetime(2026, 1, 15, 9, 30, 0, tzinfo=timezone.utc),
    }

    mock_res = MagicMock()
    mock_res.mappings.return_value.all.return_value = [row1, row2]
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=mock_res)

    repo = LabResultRepository(session=mock_session)

    res = await repo.query_longitudinal(user_id=user_id, canonical_key="fasting_blood_glucose", limit=10)

    assert res["userId"] == str(user_id)
    assert res["canonicalKey"] == "fasting_blood_glucose"
    assert res["count"] == 2
    assert "elapsedMs" in res
    assert len(res["results"]) == 2
    assert res["results"][0]["valueNumeric"] == 110.0
    assert res["results"][0]["flag"] == "HIGH"
    assert res["results"][1]["valueNumeric"] == 95.0
    assert res["results"][1]["flag"] == "NORMAL"


@pytest.mark.asyncio
async def test_get_by_document():
    user_id = uuid.uuid4()
    doc_id = uuid.uuid4()

    row = {
        "id": uuid.uuid4(),
        "canonical_key": "hemoglobin",
        "test_name": "Hemoglobin",
        "value_numeric": 14.2,
        "value_text": "14.2",
        "unit": "g/dL",
        "reference_range": "12.0 - 17.5 g/dL",
        "flag": "NORMAL",
        "is_abnormal": False,
        "is_critical": False,
        "test_date": datetime(2026, 3, 1, tzinfo=timezone.utc),
        "page_no": 1,
        "confidence": 0.99,
    }

    mock_res = MagicMock()
    mock_res.mappings.return_value.all.return_value = [row]
    mock_session = AsyncMock()
    mock_session.execute = AsyncMock(return_value=mock_res)

    repo = LabResultRepository(session=mock_session)
    results = await repo.get_by_document(user_id=user_id, document_id=doc_id)

    assert len(results) == 1
    assert results[0]["canonicalKey"] == "hemoglobin"
    assert results[0]["valueNumeric"] == 14.2


@pytest.mark.asyncio
async def test_orchestrator_stage_6_persists_lab_results(tmp_path: Path):
    """Verify that Stage 6 of PipelineOrchestrator invokes LabResultRepository."""
    user_id = uuid.uuid4()
    doc_id = uuid.uuid4()
    job_id = uuid.uuid4()
    file_key = "test-labs.pdf"

    mock_repo = MagicMock()
    mock_repo.complete_job = AsyncMock()
    mock_lifecycle = MagicMock()
    mock_lifecycle.report_progress = AsyncMock(return_value=10)
    mock_checkpoint = MagicMock()
    mock_checkpoint.persist_stage_checkpoint = AsyncMock(return_value={})
    
    mock_s3 = MagicMock()
    fake_pdf = tmp_path / "mock_labs.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 mock lab results")

    mock_ocr = MagicMock()
    mock_ocr.verify_upload = AsyncMock(return_value=fake_pdf)
    mock_ocr.validate_document = AsyncMock(return_value={"isValid": True})
    mock_ocr.run_ocr = AsyncMock(return_value={"fullText": "Lab report", "pageCount": 1})

    mock_layout = MagicMock()
    mock_layout.parse_layout = MagicMock(return_value={"tables": []})

    mock_graph = MagicMock()
    mock_graph.extract_graphs = AsyncMock(return_value=[])

    extracted_clinical = {
        "documentInfo": {"date": "2026-07-20", "documentType": "LAB_REPORT"},
        "labResults": [
            {
                "testName": "Serum Creatinine",
                "value": 1.1,
                "unit": "mg/dL",
                "flag": "NORMAL",
                "isAbnormal": False,
                "isCritical": False,
            }
        ],
    }
    mock_clinical = MagicMock()
    mock_clinical.extract_fields = AsyncMock(return_value=extracted_clinical)

    mock_analysis = MagicMock()
    mock_analysis.analyze = MagicMock(return_value={"riskLevel": "LOW"})

    mock_summary = MagicMock()
    mock_summary.generate_summary = AsyncMock(return_value={"summary": "normal"})

    mock_embedding = MagicMock()
    mock_embedding.generate_embeddings = AsyncMock(return_value={"chunkCount": 1})

    mock_lab_repo = MagicMock()
    mock_lab_repo.persist_lab_results = AsyncMock(return_value=[{"id": "persisted-1"}])

    orchestrator = PipelineOrchestrator(
        job_repo=mock_repo,
        lifecycle_service=mock_lifecycle,
        checkpoint_service=mock_checkpoint,
        s3_client=mock_s3,
        ocr_handler=mock_ocr,
        layout_handler=mock_layout,
        graph_handler=mock_graph,
        clinical_handler=mock_clinical,
        analysis_handler=mock_analysis,
        summary_handler=mock_summary,
        embedding_handler=mock_embedding,
        lab_result_repo=mock_lab_repo,
    )

    job = {
        "id": job_id,
        "file_key": file_key,
        "user_id": user_id,
        "completed_stages": [],
        "percentage": 0,
        "metadata": {
            "documentId": str(doc_id),
            "userId": str(user_id),
        },
        "checkpoint_data": {},
    }

    await orchestrator.process_job(job)

    # Verify lab_result_repo.persist_lab_results was called
    assert mock_lab_repo.persist_lab_results.called
    kwargs = mock_lab_repo.persist_lab_results.call_args.kwargs
    assert kwargs["user_id"] == user_id
    assert kwargs["document_id"] == doc_id
    assert kwargs["report_id"] == file_key
    assert len(kwargs["lab_items"]) == 1
    assert kwargs["test_date"] == "2026-07-20"


@pytest.mark.asyncio
async def test_orchestrator_stage_6_survives_persistence_failure(tmp_path: Path):
    """Verify that a persistence exception in Stage 6 is caught and does not fail the whole pipeline."""
    user_id = uuid.uuid4()
    doc_id = uuid.uuid4()
    job_id = uuid.uuid4()
    file_key = "test-error.pdf"

    mock_repo = MagicMock()
    mock_repo.complete_job = AsyncMock()
    mock_lifecycle = MagicMock()
    mock_lifecycle.report_progress = AsyncMock(return_value=10)
    mock_checkpoint = MagicMock()
    mock_checkpoint.persist_stage_checkpoint = AsyncMock(return_value={})
    
    mock_s3 = MagicMock()
    fake_pdf = tmp_path / "mock.pdf"
    fake_pdf.write_bytes(b"%PDF-1.4 mock")

    mock_ocr = MagicMock()
    mock_ocr.verify_upload = AsyncMock(return_value=fake_pdf)
    mock_ocr.validate_document = AsyncMock(return_value={"isValid": True})
    mock_ocr.run_ocr = AsyncMock(return_value={"fullText": "Lab report", "pageCount": 1})
    mock_layout = MagicMock()
    mock_layout.parse_layout = MagicMock(return_value={})
    mock_graph = MagicMock()
    mock_graph.extract_graphs = AsyncMock(return_value=[])

    mock_clinical = MagicMock()
    mock_clinical.extract_fields = AsyncMock(return_value={
        "documentInfo": {"documentType": "LAB_REPORT"},
        "labResults": [{"testName": "HbA1c", "value": 6.5}],
    })

    mock_analysis = MagicMock()
    mock_analysis.analyze = MagicMock(return_value={"riskLevel": "LOW"})
    mock_summary = MagicMock()
    mock_summary.generate_summary = AsyncMock(return_value={"summary": "normal"})
    mock_embedding = MagicMock()
    mock_embedding.generate_embeddings = AsyncMock(return_value={"chunkCount": 1})

    # Mock lab repo raising database exception
    mock_lab_repo = MagicMock()
    mock_lab_repo.persist_lab_results = AsyncMock(side_effect=Exception("Database lock error"))

    orchestrator = PipelineOrchestrator(
        job_repo=mock_repo,
        lifecycle_service=mock_lifecycle,
        checkpoint_service=mock_checkpoint,
        s3_client=mock_s3,
        ocr_handler=mock_ocr,
        layout_handler=mock_layout,
        graph_handler=mock_graph,
        clinical_handler=mock_clinical,
        analysis_handler=mock_analysis,
        summary_handler=mock_summary,
        embedding_handler=mock_embedding,
        lab_result_repo=mock_lab_repo,
    )

    job = {
        "id": job_id,
        "file_key": file_key,
        "user_id": user_id,
        "completed_stages": [],
        "percentage": 0,
        "metadata": {"documentId": str(doc_id), "userId": str(user_id)},
        "checkpoint_data": {},
    }

    # Pipeline should complete without raising an unhandled exception
    await orchestrator.process_job(job)
    assert mock_repo.complete_job.called
