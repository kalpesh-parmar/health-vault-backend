from __future__ import annotations

import asyncio
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4
import pytest
import fitz

from app.services.pipeline.ocr_stage import OcrStageHandler
from app.services.pipeline.clinical_stage import ClinicalStageHandler
from app.services.pipeline.orchestrator import PipelineOrchestrator
from app.services.pipeline.layout_stage import LayoutStageHandler
from app.services.pipeline.analysis_stage import AnalysisStageHandler


FIXTURE_PDF_PATH = (
    Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs" / "real_6page_digital.pdf"
)


@pytest.mark.asyncio
async def test_orchestrator_direct_text_pipeline_end_to_end(tmp_path: Path):
    """Part 0.1 Integration Test:
    Runs the golden fixture PDF (real_6page_digital.pdf, 6 pages born-digital) through the
    PipelineOrchestrator on the direct-text path with LLM calls mocked.
    Asserts:
      - >= 31 lab parameters extracted in extracted_structured_data["labResults"]
      - repo.complete_job called with status "COMPLETED" (SUCCESS)
      - 0 PaddleOCR calls
      - 0 Qwen-VL (VLM) calls
    """
    assert FIXTURE_PDF_PATH.exists(), f"Missing fixture at {FIXTURE_PDF_PATH}"
    temp_doc = tmp_path / "temp_orchestrator_fixture.pdf"
    temp_doc.write_bytes(FIXTURE_PDF_PATH.read_bytes())

    paddle_calls = 0
    paddle_mock = MagicMock()
    async def _mock_paddle(*args, **kwargs):
        nonlocal paddle_calls
        paddle_calls += 1
        return {"text": "", "lines": [], "confidence": 1.0}
    paddle_mock.async_extract_text_from_bytes = AsyncMock(side_effect=_mock_paddle)

    vlm_calls = 0
    vision_mock = MagicMock()
    async def _mock_vlm(*args, **kwargs):
        nonlocal vlm_calls
        vlm_calls += 1
        return {"text": "", "confidence": 1.0}
    vision_mock.extract_image = AsyncMock(side_effect=_mock_vlm)

    s3_mock = MagicMock()
    s3_mock.settings = MagicMock(aws_bucket_name="health-vault-docs")
    s3_mock.download_file = AsyncMock()

    ocr_handler = OcrStageHandler(
        s3_client=s3_mock,
        paddle_engine=paddle_mock,
        vision_service=vision_mock,
    )
    # verify_upload returns temporary copy of fixture PDF path
    ocr_handler.verify_upload = AsyncMock(return_value=temp_doc)

    clinical_handler = ClinicalStageHandler()
    layout_handler = LayoutStageHandler()
    analysis_handler = AnalysisStageHandler()

    # Mock summary and embedding stages (no live LLM dependency)
    summary_handler = MagicMock()
    summary_handler.generate_summary = AsyncMock(return_value={
        "summaryEnglish": "Complete Blood Count and Metabolic evaluation completed.",
        "summaryInPreferredLanguage": "Complete Blood Count and Metabolic evaluation completed.",
        "summaryLanguage": "english",
        "preferredLanguage": "english",
        "keyPoints": ["Hemoglobin 11.20 gm%", "RBS 271 mg/dL", "HbA1c 9.0%"],
        "dosagePreserved": True,
    })

    embedding_handler = MagicMock()
    embedding_handler.generate_embeddings = AsyncMock(return_value={"chunkCount": 3})

    graph_handler = MagicMock()
    graph_handler.extract_graphs = AsyncMock(return_value=[])

    repo = MagicMock()
    repo.complete_job = AsyncMock()
    repo.sync_to_documents_table = AsyncMock()

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()

    checkpoint = MagicMock()
    checkpoint.persist_stage_checkpoint = AsyncMock(return_value={})

    orchestrator = PipelineOrchestrator(
        job_repo=repo,
        lifecycle_service=lifecycle,
        checkpoint_service=checkpoint,
        s3_client=s3_mock,
        ocr_handler=ocr_handler,
        layout_handler=layout_handler,
        graph_handler=graph_handler,
        clinical_handler=clinical_handler,
        analysis_handler=analysis_handler,
        summary_handler=summary_handler,
        embedding_handler=embedding_handler,
    )

    job_id = uuid4()
    job = {
        "id": job_id,
        "file_key": "patient/test/5069200904.pdf",
        "checkpoint_data": {},
        "completed_stages": [],
        "percentage": 0,
        "metadata": {
            "originalName": "5069200904.pdf",
            "mimeType": "application/pdf",
        },
    }

    await orchestrator.process_job(job)

    # 1. Verification of job completion
    repo.complete_job.assert_called_once()
    call_kwargs = repo.complete_job.call_args.kwargs
    assert call_kwargs.get("status") in ("COMPLETED", "SUCCESS"), (
        f"Expected job status COMPLETED/SUCCESS, got {call_kwargs.get('status')}"
    )

    # 2. Verification of parameter count >= 31
    extracted_data = call_kwargs.get("extracted_structured_data") or {}
    lab_results = extracted_data.get("labResults") or []
    assert len(lab_results) >= 31, (
        f"Expected at least 31 extracted lab parameters, got {len(lab_results)}"
    )

    # 3. Verification of 0 Paddle and 0 VLM calls on born-digital path
    assert paddle_calls == 0, f"Expected 0 Paddle calls, got {paddle_calls}"
    assert vlm_calls == 0, f"Expected 0 VLM calls, got {vlm_calls}"


@pytest.mark.asyncio
async def test_regression_raw_text_dict_unbound_local_error():
    """Regression test for the raw_text_dict bug:
    Ensures that running OcrStageHandler.run_ocr on a born-digital multi-page PDF
    correctly initializes raw_text_dict without raising UnboundLocalError, and that
    all page numbers (1..N) are represented.
    """
    assert FIXTURE_PDF_PATH.exists()

    s3_mock = MagicMock()
    paddle_mock = MagicMock()
    vision_mock = MagicMock()

    handler = OcrStageHandler(
        s3_client=s3_mock,
        paddle_engine=paddle_mock,
        vision_service=vision_mock,
    )

    # Should run to completion without UnboundLocalError: local variable 'raw_text_dict' referenced before assignment
    result = await handler.run_ocr(
        file_path=FIXTURE_PDF_PATH,
        filename="5069200904.pdf",
        job_id=uuid4(),
        file_key="test/regression_raw_text_dict.pdf",
        current_pct=0,
        completed_stages=[],
        checkpoint_data={},
    )

    assert result["pageCount"] == 6
    assert result["metrics"]["used_direct_text"] is True
    assert "spatial_parameters" in result
    assert len(result["spatial_parameters"]) >= 31
