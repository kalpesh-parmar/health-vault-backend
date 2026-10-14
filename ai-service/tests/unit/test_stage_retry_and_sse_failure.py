from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4

import pytest

from app.constants.stages import (
    STAGE_ANALYZING,
    STAGE_EMBEDDING,
    STAGE_FIELD_EXTRACTION,
    STAGE_GRAPH_EXTRACTION,
    STAGE_OCR_RUNNING,
    STAGE_PARSING,
    STAGE_QUEUED,
    STAGE_SUMMARIZING,
    STAGE_UPLOADING,
    STAGE_VALIDATING,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_IN_PROGRESS,
)
from app.core.errors import OcrStageFailureError, StageExecutionError
from app.services.pipeline.ocr_stage import (
    has_ocr_failure_placeholders,
    validate_ocr_result,
)
from app.services.pipeline.orchestrator import PipelineOrchestrator


@pytest.fixture
def mock_pipeline_dependencies(tmp_path: Path):
    job_repo = AsyncMock()
    lifecycle_service = AsyncMock()
    lifecycle_service.notifier = AsyncMock()
    checkpoint_service = AsyncMock()
    s3_client = MagicMock()
    s3_client.settings = MagicMock(aws_bucket_name="health-vault-documents")
    s3_client.read_bytes = AsyncMock()

    ocr_handler = AsyncMock()
    test_pdf = tmp_path / "mock.pdf"
    test_pdf.write_bytes(b"%PDF-1.4 mock pdf content")
    ocr_handler.verify_upload = AsyncMock(return_value=test_pdf)
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
    summary_handler.generate_summary = AsyncMock(return_value={"summaryEnglish": "Clinical report"})

    embedding_handler = AsyncMock()
    embedding_handler.generate_embeddings = AsyncMock(return_value={"chunkCount": 3})

    orchestrator = PipelineOrchestrator(
        job_repo=job_repo,
        lifecycle_service=lifecycle_service,
        checkpoint_service=checkpoint_service,
        s3_client=s3_client,
        ocr_handler=ocr_handler,
        layout_handler=layout_handler,
        graph_handler=graph_handler,
        clinical_handler=clinical_handler,
        analysis_handler=analysis_handler,
        summary_handler=summary_handler,
        embedding_handler=embedding_handler,
    )

    return {
        "orchestrator": orchestrator,
        "job_repo": job_repo,
        "lifecycle": lifecycle_service,
        "checkpoint": checkpoint_service,
        "ocr_handler": ocr_handler,
        "layout_handler": layout_handler,
        "summary_handler": summary_handler,
        "embedding_handler": embedding_handler,
    }


@pytest.mark.asyncio
async def test_stage_failure_at_ocr_running_stops_pipeline(mock_pipeline_dependencies):
    """When OCR_RUNNING fails, pipeline halts, persists FAILED with failed_stage=OCR_RUNNING, emits SSE, and does not execute downstream stages."""
    deps = mock_pipeline_dependencies
    orch: PipelineOrchestrator = deps["orchestrator"]
    repo = deps["job_repo"]
    notifier = deps["lifecycle"].notifier
    ocr_handler = deps["ocr_handler"]
    layout_handler = deps["layout_handler"]

    job_id = uuid4()
    file_key = "prescription.pdf"

    # Make OCR stage fail
    ocr_handler.run_ocr.side_effect = OcrStageFailureError(
        message="Both PaddleOCR and Qwen-VL failed to extract text",
        error_code="OCR_EXTRACTION_FAILED",
        failed_stage=STAGE_OCR_RUNNING,
        retryable=True,
    )

    job = {
        "id": job_id,
        "file_key": file_key,
        "status": "RUNNING",
        "stage": STAGE_QUEUED,
        "percentage": 0,
        "completed_stages": [],
        "checkpoint_data": {},
        "attempt_count": 1,
    }

    await orch.process_job(job)

    # 1. Job repository marked FAILED with exact failed_stage
    repo.fail_job.assert_awaited_once()
    fail_call_kwargs = repo.fail_job.call_args.kwargs
    assert fail_call_kwargs["job_id"] == job_id
    assert fail_call_kwargs["failed_stage"] == STAGE_OCR_RUNNING
    assert fail_call_kwargs["error_code"] == "OCR_EXTRACTION_FAILED"
    assert fail_call_kwargs["retryable"] is True
    assert fail_call_kwargs["attempt_count"] == 1
    # Check that VALIDATING and UPLOADING are preserved in completed_stages
    assert STAGE_VALIDATING in fail_call_kwargs["completed_stages"]
    assert STAGE_UPLOADING in fail_call_kwargs["completed_stages"]
    assert STAGE_OCR_RUNNING not in fail_call_kwargs["completed_stages"]

    # 2. Emitted terminal FAILED event through notifier
    notifier.publish_progress.assert_awaited_once()
    event_call = notifier.publish_progress.call_args.kwargs
    assert event_call["job_id"] == job_id
    assert event_call["stage"] == STAGE_OCR_RUNNING
    assert event_call["stage_status"] == STATUS_FAILED
    assert event_call["error_code"] == "OCR_EXTRACTION_FAILED"
    assert event_call["failed_stage"] == STAGE_OCR_RUNNING
    assert event_call["retryable"] is True
    assert event_call["attempt_count"] == 1

    # 3. Downstream stages were NOT executed
    layout_handler.parse_layout.assert_not_called()
    repo.complete_job.assert_not_called()


@pytest.mark.asyncio
async def test_stage_level_retry_resumes_from_ocr_running(mock_pipeline_dependencies):
    """On retry after OCR_RUNNING failure, VALIDATING and UPLOADING are skipped, OCR_RUNNING reruns, and all downstream stages finish to COMPLETED."""
    deps = mock_pipeline_dependencies
    orch: PipelineOrchestrator = deps["orchestrator"]
    repo = deps["job_repo"]
    ocr_handler = deps["ocr_handler"]
    layout_handler = deps["layout_handler"]
    embedding_handler = deps["embedding_handler"]

    job_id = uuid4()
    file_key = "prescription.pdf"

    # OCR succeeds on retry attempt
    ocr_handler.run_ocr.return_value = {
        "pages": [{"page": 1, "text": "Patient: Ramesh Patel\nDiagnosis: Hypertension", "status": "SUCCESS"}],
        "fullText": "Patient: Ramesh Patel\nDiagnosis: Hypertension",
        "pageCount": 1,
        "metrics": {"failed_page_count": 0},
    }

    job_on_retry = {
        "id": job_id,
        "file_key": file_key,
        "status": "RUNNING",
        "stage": STAGE_OCR_RUNNING,
        "failed_stage": STAGE_OCR_RUNNING,
        "percentage": 25,
        "completed_stages": [STAGE_VALIDATING, STAGE_UPLOADING],
        "checkpoint_data": {
            "failedStage": STAGE_OCR_RUNNING,
            STAGE_VALIDATING: {"isValid": True},
            STAGE_UPLOADING: {"uploaded": True},
        },
        "attempt_count": 2,
    }

    await orch.process_job(job_on_retry)

    # 1. VALIDATING and UPLOADING were skipped (validate_document not called again)
    ocr_handler.validate_document.assert_not_called()

    # 2. OCR_RUNNING was rerun
    ocr_handler.run_ocr.assert_awaited_once()

    # 3. Downstream stages executed in sequence
    layout_handler.parse_layout.assert_called_once()
    embedding_handler.generate_embeddings.assert_awaited_once()

    # 4. Job marked COMPLETED with attempt_count 2
    repo.complete_job.assert_awaited_once()
    complete_kwargs = repo.complete_job.call_args.kwargs
    assert complete_kwargs["job_id"] == job_id
    assert complete_kwargs["status"] == "COMPLETED"
    assert complete_kwargs["attempt_count"] == 2
    assert set(complete_kwargs["completed_stages"]) == {
        STAGE_VALIDATING,
        STAGE_UPLOADING,
        STAGE_OCR_RUNNING,
        STAGE_PARSING,
        STAGE_GRAPH_EXTRACTION,
        STAGE_FIELD_EXTRACTION,
        STAGE_ANALYZING,
        STAGE_SUMMARIZING,
        STAGE_EMBEDDING,
    }


@pytest.mark.asyncio
async def test_failure_at_summarizing_and_retry_resumes_cleanly(mock_pipeline_dependencies):
    """When SUMMARIZING fails, stages 1-7 are skipped on retry, SUMMARIZING reruns, EMBEDDING executes, and job completes."""
    deps = mock_pipeline_dependencies
    orch: PipelineOrchestrator = deps["orchestrator"]
    repo = deps["job_repo"]
    notifier = deps["lifecycle"].notifier
    ocr_handler = deps["ocr_handler"]
    summary_handler = deps["summary_handler"]
    embedding_handler = deps["embedding_handler"]

    job_id = uuid4()
    file_key = "lab_report.pdf"

    # 1. First run: SUMMARIZING fails
    summary_handler.generate_summary.side_effect = RuntimeError("LLM synthesis timeout")

    prior_completed = [
        STAGE_VALIDATING,
        STAGE_UPLOADING,
        STAGE_OCR_RUNNING,
        STAGE_PARSING,
        STAGE_GRAPH_EXTRACTION,
        STAGE_FIELD_EXTRACTION,
        STAGE_ANALYZING,
    ]

    job_failing_at_summary = {
        "id": job_id,
        "file_key": file_key,
        "status": "RUNNING",
        "stage": STAGE_SUMMARIZING,
        "percentage": 85,
        "completed_stages": list(prior_completed),
        "checkpoint_data": {
            STAGE_OCR_RUNNING: {"fullText": "Hemoglobin: 14.2 g/dL", "metrics": {"failed_page_count": 0}},
            STAGE_FIELD_EXTRACTION: {"labResults": [{"param": "Hemoglobin", "val": 14.2}]},
        },
        "raw_ocr_data": {"fullText": "Hemoglobin: 14.2 g/dL", "metrics": {"failed_page_count": 0}},
        "extracted_structured_data": {"labResults": [{"param": "Hemoglobin", "val": 14.2}]},
        "attempt_count": 1,
    }

    # Set checkpoint loader returns
    deps["checkpoint"].load_raw_ocr_data = AsyncMock(return_value={"fullText": "Hemoglobin: 14.2 g/dL", "metrics": {"failed_page_count": 0}})
    deps["checkpoint"].load_extracted_structured_data = AsyncMock(return_value={"labResults": [{"param": "Hemoglobin", "val": 14.2}]})

    await orch.process_job(job_failing_at_summary)

    # Verified failure persisted
    repo.fail_job.assert_awaited_once()
    assert repo.fail_job.call_args.kwargs["failed_stage"] == STAGE_SUMMARIZING
    notifier.publish_progress.assert_awaited_once()
    assert notifier.publish_progress.call_args.kwargs["stage"] == STAGE_SUMMARIZING
    assert notifier.publish_progress.call_args.kwargs["stage_status"] == STATUS_FAILED
    # EMBEDDING not called
    embedding_handler.generate_embeddings.assert_not_called()

    # 2. Retry run: SUMMARIZING succeeds
    repo.fail_job.reset_mock()
    notifier.publish_progress.reset_mock()
    summary_handler.generate_summary.side_effect = None
    summary_handler.generate_summary.reset_mock()
    summary_handler.generate_summary.return_value = {
        "summaryEnglish": "Normal hemoglobin level.",
        "keyFindings": ["Hemoglobin 14.2"],
    }

    job_retry_summary = {
        "id": job_id,
        "file_key": file_key,
        "status": "RUNNING",
        "stage": STAGE_SUMMARIZING,
        "failed_stage": STAGE_SUMMARIZING,
        "percentage": 85,
        "completed_stages": list(prior_completed),
        "checkpoint_data": {
            "failedStage": STAGE_SUMMARIZING,
            STAGE_OCR_RUNNING: {"fullText": "Hemoglobin: 14.2 g/dL", "metrics": {"failed_page_count": 0}},
            STAGE_FIELD_EXTRACTION: {"labResults": [{"param": "Hemoglobin", "val": 14.2}]},
        },
        "raw_ocr_data": {"fullText": "Hemoglobin: 14.2 g/dL", "metrics": {"failed_page_count": 0}},
        "extracted_structured_data": {"labResults": [{"param": "Hemoglobin", "val": 14.2}]},
        "attempt_count": 2,
    }

    await orch.process_job(job_retry_summary)

    # Prerequisite stages 1-7 skipped:
    ocr_handler.run_ocr.assert_not_called()
    # SUMMARIZING executed
    summary_handler.generate_summary.assert_awaited_once()
    # EMBEDDING executed
    embedding_handler.generate_embeddings.assert_awaited_once()
    # Job completed
    repo.complete_job.assert_awaited_once()
    assert repo.complete_job.call_args.kwargs["status"] == "COMPLETED"


def test_ocr_failure_placeholder_detection():
    """Verify that explicit page failure markers are flagged as invalid."""
    assert has_ocr_failure_placeholders("[PAGE 1 OCR FAILED - CLINICAL DATA UNREADABLE]") is True
    assert has_ocr_failure_placeholders("Patient diagnosed with diabetes. [PAGE 2 OCR FAILED - CLINICAL DATA UNREADABLE]") is True
    assert has_ocr_failure_placeholders("Normal prescription text") is False
    assert has_ocr_failure_placeholders(None) is False

    with pytest.raises(OcrStageFailureError) as exc_info:
        validate_ocr_result({
            "fullText": "[PAGE 1 OCR FAILED - CLINICAL DATA UNREADABLE]",
            "pages": [{"page": 1, "status": "FAILED"}],
            "metrics": {"failed_page_count": 1},
        })
    assert exc_info.value.error_code == "OCR_EXTRACTION_FAILED"
    assert exc_info.value.stage == STAGE_OCR_RUNNING


@pytest.mark.asyncio
async def test_target_unique_pdf_failure_and_resume_flow(mock_pipeline_dependencies, tmp_path: Path):
    """Validates the exact target PDF 'Unique(28122024).pdf' flow:
    1. Initial run: OCR failure placeholders produced -> halted at OCR_RUNNING with status FAILED.
    2. Retry: VALIDATING and UPLOADING checkpoints reused from S3, OCR reruns and succeeds, pipeline marks COMPLETED.
    """
    deps = mock_pipeline_dependencies
    orch: PipelineOrchestrator = deps["orchestrator"]
    repo = deps["job_repo"]
    notifier = deps["lifecycle"].notifier
    ocr_handler = deps["ocr_handler"]

    golden_pdf_path = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "Unique(28122024).pdf"
    if not golden_pdf_path.exists():
        golden_pdf_path = tmp_path / "Unique(28122024).pdf"
        golden_pdf_path.write_bytes(b"%PDF-1.4 mock unique pdf")

    job_id = uuid4()
    file_key = "Unique(28122024).pdf"
    ocr_handler.verify_upload = AsyncMock(return_value=golden_pdf_path)

    # 1. OCR returns failure placeholder
    ocr_handler.run_ocr.return_value = {
        "pages": [
            {"page": 1, "status": "FAILED", "text": ""},
            {"page": 2, "status": "FAILED", "text": ""},
        ],
        "fullText": "[PAGE 1 OCR FAILED - CLINICAL DATA UNREADABLE]\n\n[PAGE 2 OCR FAILED - CLINICAL DATA UNREADABLE]",
        "pageCount": 2,
        "metrics": {"failed_page_count": 2},
    }

    job_initial = {
        "id": job_id,
        "file_key": file_key,
        "status": "RUNNING",
        "stage": STAGE_QUEUED,
        "percentage": 0,
        "completed_stages": [],
        "checkpoint_data": {},
        "attempt_count": 1,
    }

    await orch.process_job(job_initial)

    # Halts at OCR_RUNNING with FAILED
    repo.fail_job.assert_awaited_once()
    assert repo.fail_job.call_args.kwargs["failed_stage"] == STAGE_OCR_RUNNING
    notifier.publish_progress.assert_awaited_once()
    assert notifier.publish_progress.call_args.kwargs["stage_status"] == STATUS_FAILED
    assert notifier.publish_progress.call_args.kwargs["stage"] == STAGE_OCR_RUNNING
    repo.complete_job.assert_not_called()

    # 2. Retry run: OCR succeeds with actual medical transcription
    repo.fail_job.reset_mock()
    notifier.publish_progress.reset_mock()
    ocr_handler.validate_document.reset_mock()
    ocr_handler.run_ocr.reset_mock()

    ocr_handler.run_ocr.return_value = {
        "pages": [
            {"page": 1, "status": "SUCCESS", "text": "Dr. Jay M. Makadiya\nConsultant Urosurgeon\nTemusin 0.4mg"},
            {"page": 2, "status": "SUCCESS", "text": "UROFLOWMETRY REPORT\nPatient: Valsibhai\nVoided Volume: 71ml\nMax Flow: 09 ml/sec"},
        ],
        "fullText": "Dr. Jay M. Makadiya\nConsultant Urosurgeon\nTemusin 0.4mg\n\nUROFLOWMETRY REPORT\nPatient: Valsibhai\nVoided Volume: 71ml\nMax Flow: 09 ml/sec",
        "pageCount": 2,
        "metrics": {"failed_page_count": 0},
    }

    orch.clinical_handler.extract_fields = AsyncMock(
        return_value={
            "labResults": [
                {"page": 1, "parameter": "Temusin", "value": 0.4},
                {"page": 2, "parameter": "Voided Volume", "value": 71},
            ]
        }
    )

    job_retry = {
        "id": job_id,
        "file_key": file_key,
        "status": "RUNNING",
        "stage": STAGE_OCR_RUNNING,
        "failed_stage": STAGE_OCR_RUNNING,
        "percentage": 25,
        "completed_stages": [STAGE_VALIDATING, STAGE_UPLOADING],
        "checkpoint_data": {
            "failedStage": STAGE_OCR_RUNNING,
            STAGE_VALIDATING: {"isValid": True},
            STAGE_UPLOADING: {"uploaded": True, "s3Key": file_key},
        },
        "attempt_count": 2,
    }

    await orch.process_job(job_retry)

    # Prerequisite VALIDATING skipped (validate_document not called)
    ocr_handler.validate_document.assert_not_called()
    # OCR_RUNNING was rerun
    ocr_handler.run_ocr.assert_awaited_once()
    # All stages completed successfully
    repo.complete_job.assert_awaited_once()
    assert repo.complete_job.call_args.kwargs["status"] == "COMPLETED"
    assert repo.complete_job.call_args.kwargs["attempt_count"] == 2
