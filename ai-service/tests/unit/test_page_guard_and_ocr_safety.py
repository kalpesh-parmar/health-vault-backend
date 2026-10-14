import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4
import pytest

from app.services.pipeline.ocr_stage import OcrStageHandler, _render_single_pdf_page
from app.services.pipeline.orchestrator import PipelineOrchestrator


from app.constants.stages import (
    STAGE_EMBEDDING,
    STAGE_QUEUED,
    STATUS_COMPLETED,
    STATUS_FAILED,
)


def _build_test_orchestrator(repo, lifecycle, checkpoint, tmp_path):
    ocr_handler = AsyncMock()
    mock_pdf = tmp_path / "doc.pdf"
    mock_pdf.write_bytes(b"%PDF-1.4 mock content")
    ocr_handler.verify_upload = AsyncMock(return_value=mock_pdf)
    ocr_handler.validate_document = AsyncMock(return_value={"isValid": True})

    layout_handler = MagicMock()
    layout_handler.parse_layout = MagicMock(return_value={"blocks": [], "tables": []})

    graph_handler = AsyncMock()
    graph_handler.extract_graphs = AsyncMock(return_value=[])

    clinical_handler = AsyncMock()
    clinical_handler.extract_fields = AsyncMock(return_value={"labResults": []})

    analysis_handler = MagicMock()
    analysis_handler.analyze = MagicMock(return_value={"riskLevel": "NORMAL"})

    summary_handler = AsyncMock()
    summary_handler.generate_summary = AsyncMock(return_value={"summaryEnglish": "Summary content"})

    embedding_handler = AsyncMock()
    embedding_handler.generate_embeddings = AsyncMock(return_value={"chunkCount": 1})

    s3_client = MagicMock()
    s3_client.settings = MagicMock(aws_bucket_name="test-bucket")

    # Set up checkpoint service defaults
    checkpoint.persist_stage_checkpoint = AsyncMock(
        side_effect=lambda **kw: kw.get("checkpoint_data", {})
    )
    checkpoint.load_raw_ocr_data = AsyncMock(return_value=None)
    checkpoint.load_extracted_structured_data = AsyncMock(return_value=None)

    return PipelineOrchestrator(
        job_repo=repo,
        lifecycle_service=lifecycle,
        checkpoint_service=checkpoint,
        s3_client=s3_client,
        ocr_handler=ocr_handler,
        layout_handler=layout_handler,
        graph_handler=graph_handler,
        clinical_handler=clinical_handler,
        analysis_handler=analysis_handler,
        summary_handler=summary_handler,
        embedding_handler=embedding_handler,
    )


@pytest.mark.asyncio
async def test_discharge_summary_with_numeric_vitals_completes_as_completed(tmp_path):
    """Discharge summary containing dates and numeric vitals without lab parameters must mark COMPLETED."""
    repo = MagicMock()
    repo.complete_job = AsyncMock(return_value=True)
    repo.sync_to_documents_table = AsyncMock()
    repo.fail_job = AsyncMock(return_value=True)

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()
    notifier = AsyncMock()
    lifecycle.notifier = notifier
    checkpoint = MagicMock()
    checkpoint.is_cancelled = AsyncMock(return_value=False)
    checkpoint.load_raw_ocr_data = AsyncMock(return_value=None)
    checkpoint.load_extracted_structured_data = AsyncMock(return_value=None)

    orch = _build_test_orchestrator(repo, lifecycle, checkpoint, tmp_path)

    orch.ocr_handler.run_ocr.return_value = {
        "pages": [
            {
                "page": 1,
                "text": "DISCHARGE SUMMARY\nDOA: 15-Jan-2025\nBP: 120/80 mmHg\nPulse: 72 bpm\nFollow-up: 7 days",
                "status": "SUCCESS",
            }
        ],
        "fullText": "DISCHARGE SUMMARY\nDOA: 15-Jan-2025\nBP: 120/80 mmHg\nPulse: 72 bpm\nFollow-up: 7 days",
        "pageCount": 1,
        "metrics": {"failed_page_count": 0},
    }

    orch.clinical_handler.extract_fields.return_value = {
        "documentInfo": {"documentType": "DISCHARGE_SUMMARY"},
        "vitals": {"bloodPressure": "120/80", "pulse": 72},
        "labResults": [],
    }

    job_id = uuid4()
    doc_id = uuid4()
    job = {
        "id": job_id,
        "document_id": doc_id,
        "file_key": "discharge_summary.pdf",
        "status": "RUNNING",
        "stage": STAGE_QUEUED,
        "percentage": 0,
        "completed_stages": [],
        "checkpoint_data": {},
        "attempt_count": 1,
    }

    await orch.process_job(job)

    # Must complete as COMPLETED, never PARTIAL
    repo.complete_job.assert_awaited_once()
    complete_kwargs = repo.complete_job.call_args.kwargs
    assert complete_kwargs["status"] == "COMPLETED"
    assert "Document processing completed successfully" in complete_kwargs["message"]

    # Obsolete partial metadata must be stripped
    struct_data = complete_kwargs["extracted_structured_data"]
    assert struct_data.get("status") != "partial"
    assert "partialPages" not in struct_data
    assert "partial_pages" not in struct_data

    # PostgreSQL documents sync called
    repo.sync_to_documents_table.assert_awaited_once()
    assert repo.sync_to_documents_table.call_args.kwargs["document_id"] == doc_id

    # SSE progress emitted 100% COMPLETED
    lifecycle.report_progress.assert_awaited()
    last_progress = lifecycle.report_progress.call_args.kwargs
    assert last_progress["stage_status"] == STATUS_COMPLETED
    assert last_progress["previous_percentage"] == 100
    repo.fail_job.assert_not_called()


@pytest.mark.asyncio
async def test_prescription_with_medication_dosages_completes_as_completed(tmp_path):
    """Prescription with dosages and frequencies without lab parameters must mark COMPLETED."""
    repo = MagicMock()
    repo.complete_job = AsyncMock(return_value=True)
    repo.sync_to_documents_table = AsyncMock()
    repo.fail_job = AsyncMock(return_value=True)

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()
    lifecycle.notifier = AsyncMock()
    checkpoint = MagicMock()
    checkpoint.is_cancelled = AsyncMock(return_value=False)
    checkpoint.load_raw_ocr_data = AsyncMock(return_value=None)
    checkpoint.load_extracted_structured_data = AsyncMock(return_value=None)

    orch = _build_test_orchestrator(repo, lifecycle, checkpoint, tmp_path)

    orch.ocr_handler.run_ocr.return_value = {
        "pages": [
            {
                "page": 1,
                "text": "Rx: Tab Metformin 500mg 1-0-1\nTab Telmisartan 40mg 1-0-0\nQty: 30 days",
                "status": "SUCCESS",
            }
        ],
        "fullText": "Rx: Tab Metformin 500mg 1-0-1\nTab Telmisartan 40mg 1-0-0\nQty: 30 days",
        "pageCount": 1,
        "metrics": {"failed_page_count": 0},
    }

    orch.clinical_handler.extract_fields.return_value = {
        "documentInfo": {"documentType": "PRESCRIPTION"},
        "medications": [
            {"name": "Metformin", "dosage": "500mg", "frequency": "1-0-1"},
            {"name": "Telmisartan", "dosage": "40mg", "frequency": "1-0-0"},
        ],
        "labResults": [],
    }

    job_id = uuid4()
    job = {
        "id": job_id,
        "document_id": uuid4(),
        "file_key": "prescription.pdf",
        "status": "RUNNING",
        "stage": STAGE_QUEUED,
        "percentage": 0,
        "completed_stages": [],
        "checkpoint_data": {},
        "attempt_count": 1,
    }

    await orch.process_job(job)

    repo.complete_job.assert_awaited_once()
    assert repo.complete_job.call_args.kwargs["status"] == "COMPLETED"
    repo.fail_job.assert_not_called()


@pytest.mark.asyncio
async def test_lab_report_with_parameters_completes_as_completed(tmp_path):
    """Lab report with extracted parameters completes as COMPLETED."""
    repo = MagicMock()
    repo.complete_job = AsyncMock(return_value=True)
    repo.sync_to_documents_table = AsyncMock()
    repo.fail_job = AsyncMock(return_value=True)

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()
    lifecycle.notifier = AsyncMock()
    checkpoint = MagicMock()
    checkpoint.is_cancelled = AsyncMock(return_value=False)
    checkpoint.load_raw_ocr_data = AsyncMock(return_value=None)
    checkpoint.load_extracted_structured_data = AsyncMock(return_value=None)

    orch = _build_test_orchestrator(repo, lifecycle, checkpoint, tmp_path)

    orch.ocr_handler.run_ocr.return_value = {
        "pages": [
            {"page": 1, "text": "Hemoglobin: 13.8 g/dL\nRBC: 4.8 mil/uL", "status": "SUCCESS"}
        ],
        "fullText": "Hemoglobin: 13.8 g/dL\nRBC: 4.8 mil/uL",
        "pageCount": 1,
        "metrics": {"failed_page_count": 0},
    }

    orch.clinical_handler.extract_fields.return_value = {
        "documentInfo": {"documentType": "LAB_REPORT"},
        "labResults": [
            {"testName": "Hemoglobin", "value": 13.8, "unit": "g/dL", "page": 1},
            {"testName": "RBC", "value": 4.8, "unit": "mil/uL", "page": 1},
        ],
    }

    job_id = uuid4()
    job = {
        "id": job_id,
        "document_id": uuid4(),
        "file_key": "cbc_report.pdf",
        "status": "RUNNING",
        "stage": STAGE_QUEUED,
        "percentage": 0,
        "completed_stages": [],
        "checkpoint_data": {},
        "attempt_count": 1,
    }

    await orch.process_job(job)

    repo.complete_job.assert_awaited_once()
    assert repo.complete_job.call_args.kwargs["status"] == "COMPLETED"
    repo.fail_job.assert_not_called()


@pytest.mark.asyncio
async def test_document_with_missing_optional_clinical_fields_completes_as_completed(tmp_path):
    """Missing optional fields (doctor, date, hospital) must not downgrade status to PARTIAL."""
    repo = MagicMock()
    repo.complete_job = AsyncMock(return_value=True)
    repo.sync_to_documents_table = AsyncMock()
    repo.fail_job = AsyncMock(return_value=True)

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()
    lifecycle.notifier = AsyncMock()
    checkpoint = MagicMock()
    checkpoint.is_cancelled = AsyncMock(return_value=False)
    checkpoint.load_raw_ocr_data = AsyncMock(return_value=None)
    checkpoint.load_extracted_structured_data = AsyncMock(return_value=None)

    orch = _build_test_orchestrator(repo, lifecycle, checkpoint, tmp_path)

    orch.ocr_handler.run_ocr.return_value = {
        "pages": [{"page": 1, "text": "Consultation note: Patient reports recovery.", "status": "SUCCESS"}],
        "fullText": "Consultation note: Patient reports recovery.",
        "pageCount": 1,
        "metrics": {"failed_page_count": 0},
    }

    # All optional fields omitted
    orch.clinical_handler.extract_fields.return_value = {
        "documentInfo": {"documentType": "CONSULTATION_NOTE"},
        "doctorName": None,
        "hospitalName": None,
        "reportDate": None,
        "labResults": [],
    }

    job = {
        "id": uuid4(),
        "document_id": uuid4(),
        "file_key": "note.pdf",
        "status": "RUNNING",
        "stage": STAGE_QUEUED,
        "percentage": 0,
        "completed_stages": [],
        "checkpoint_data": {},
        "attempt_count": 1,
    }

    await orch.process_job(job)

    repo.complete_job.assert_awaited_once()
    assert repo.complete_job.call_args.kwargs["status"] == "COMPLETED"
    repo.fail_job.assert_not_called()


@pytest.mark.asyncio
async def test_db_sync_failure_halts_completion_and_marks_job_failed(tmp_path):
    """If database synchronization to documents table fails, completion must NOT succeed."""
    repo = MagicMock()
    repo.complete_job = AsyncMock(return_value=True)
    repo.sync_to_documents_table = AsyncMock(side_effect=RuntimeError("PostgreSQL connection lost during sync"))
    repo.fail_job = AsyncMock(return_value=True)

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()
    lifecycle.notifier = AsyncMock()
    checkpoint = MagicMock()
    checkpoint.is_cancelled = AsyncMock(return_value=False)
    checkpoint.load_raw_ocr_data = AsyncMock(return_value=None)
    checkpoint.load_extracted_structured_data = AsyncMock(return_value=None)

    orch = _build_test_orchestrator(repo, lifecycle, checkpoint, tmp_path)

    orch.ocr_handler.run_ocr.return_value = {
        "pages": [{"page": 1, "text": "Valid document text", "status": "SUCCESS"}],
        "fullText": "Valid document text",
        "pageCount": 1,
        "metrics": {"failed_page_count": 0},
    }

    job = {
        "id": uuid4(),
        "document_id": uuid4(),
        "file_key": "sync_fail.pdf",
        "status": "RUNNING",
        "stage": STAGE_QUEUED,
        "percentage": 0,
        "completed_stages": [],
        "checkpoint_data": {},
        "attempt_count": 1,
    }

    await orch.process_job(job)

    # complete_job must NOT have been called
    repo.complete_job.assert_not_called()

    # fail_job must have been called
    repo.fail_job.assert_awaited_once()
    fail_kwargs = repo.fail_job.call_args.kwargs
    assert "DATABASE_ERROR" in fail_kwargs["error"] or "PostgreSQL connection lost" in fail_kwargs["error"]
    assert lifecycle.notifier.publish_progress.called
    assert lifecycle.notifier.publish_progress.call_args.kwargs["stage_status"] == STATUS_FAILED


@pytest.mark.asyncio
async def test_sse_emitted_only_after_successful_persistence(tmp_path):
    """Validate strict execution order: DB sync -> DB complete_job -> SSE 100% COMPLETED."""
    call_log = []

    repo = MagicMock()
    repo.sync_to_documents_table = AsyncMock(side_effect=lambda **kw: call_log.append("sync_to_documents_table"))
    repo.complete_job = AsyncMock(side_effect=lambda **kw: call_log.append("complete_job"))
    repo.fail_job = AsyncMock()

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock(side_effect=lambda **kw: call_log.append(f"progress_{kw.get('previous_percentage')}"))
    lifecycle.notifier = AsyncMock()
    checkpoint = MagicMock()
    checkpoint.is_cancelled = AsyncMock(return_value=False)
    checkpoint.load_raw_ocr_data = AsyncMock(return_value=None)
    checkpoint.load_extracted_structured_data = AsyncMock(return_value=None)

    orch = _build_test_orchestrator(repo, lifecycle, checkpoint, tmp_path)
    orch.ocr_handler.run_ocr.return_value = {
        "pages": [{"page": 1, "text": "Report text", "status": "SUCCESS"}],
        "fullText": "Report text",
        "pageCount": 1,
        "metrics": {"failed_page_count": 0},
    }

    job = {
        "id": uuid4(),
        "document_id": uuid4(),
        "file_key": "order_test.pdf",
        "status": "RUNNING",
        "stage": STAGE_QUEUED,
        "percentage": 0,
        "completed_stages": [],
        "checkpoint_data": {},
        "attempt_count": 1,
    }

    await orch.process_job(job)

    # Verify order of terminal persistence and SSE notification
    assert "sync_to_documents_table" in call_log
    assert "complete_job" in call_log
    assert "progress_100" in call_log

    sync_idx = call_log.index("sync_to_documents_table")
    complete_idx = call_log.index("complete_job")
    progress_idx = call_log.index("progress_100")

    assert sync_idx < complete_idx < progress_idx, f"Unexpected execution order: {call_log}"


@pytest.mark.asyncio
async def test_cancellation_during_processing_halts_cleanly(tmp_path):
    """When a job processing task is cancelled mid-pipeline, it raises CancelledError and halts cleanly."""
    repo = MagicMock()
    repo.complete_job = AsyncMock()
    repo.fail_job = AsyncMock()
    repo.sync_to_documents_table = AsyncMock()

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()
    lifecycle.notifier = AsyncMock()

    checkpoint = MagicMock()

    orch = _build_test_orchestrator(repo, lifecycle, checkpoint, tmp_path)

    async def slow_ocr(**kw):
        await asyncio.sleep(10)
        return {}

    orch.ocr_handler.run_ocr = AsyncMock(side_effect=slow_ocr)

    job = {
        "id": uuid4(),
        "document_id": uuid4(),
        "file_key": "cancelled.pdf",
        "status": "RUNNING",
        "stage": STAGE_QUEUED,
        "percentage": 0,
        "completed_stages": [],
        "checkpoint_data": {},
        "attempt_count": 1,
    }

    task = asyncio.create_task(orch.process_job(job))
    await asyncio.sleep(0.01)
    task.cancel()

    with pytest.raises(asyncio.CancelledError):
        await task

    # Neither complete nor sync should be called
    repo.complete_job.assert_not_called()
    repo.sync_to_documents_table.assert_not_called()



def test_scanned_page_low_memory_concurrency_and_dpi():
    """Verify that when free RAM is < 1.5 GB, concurrency is reduced to 1 and DPI is set to 100-120."""
    with patch("psutil.virtual_memory") as mock_vm:
        # Mock 1.0 GB free RAM (< 1.5 GB)
        mock_vm.return_value.available = 1.0 * (1024 ** 3)

        handler = OcrStageHandler(s3_client=MagicMock())
        concurrency, target_dpi = handler._determine_scanned_render_params()

        assert concurrency == 1, f"Expected concurrency 1 under low RAM, got {concurrency}"
        assert 100 <= target_dpi <= 120, f"Expected DPI between 100 and 120, got {target_dpi}"

    with patch("psutil.virtual_memory") as mock_vm:
        # Mock 8.0 GB free RAM (healthy)
        mock_vm.return_value.available = 8.0 * (1024 ** 3)

        handler = OcrStageHandler(s3_client=MagicMock())
        concurrency, target_dpi = handler._determine_scanned_render_params()

        assert concurrency > 1
        assert target_dpi == 150


@pytest.mark.asyncio
async def test_paddle_oom_degrades_gracefully_and_is_logged(caplog):
    """Verify that Paddle OOM exception degrades gracefully to fallback and is logged."""
    paddle_mock = MagicMock()
    paddle_mock.async_extract_text_from_bytes = AsyncMock(
        side_effect=MemoryError("CUDA out of memory in PaddleOCR engine")
    )

    handler = OcrStageHandler(s3_client=MagicMock(), paddle_engine=paddle_mock)

    import logging
    with caplog.at_level(logging.ERROR):
        result = await handler._extract_paddle_safe(b"fake_image_bytes")

    assert result.get("oom") is True or result.get("error") == "paddle_oom"
    assert any("out-of-memory" in rec.message.lower() or "oom" in rec.message.lower() for rec in caplog.records)
