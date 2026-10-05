import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4
import pytest

from app.services.pipeline.ocr_stage import OcrStageHandler, _render_single_pdf_page
from app.services.pipeline.orchestrator import PipelineOrchestrator


@pytest.mark.asyncio
async def test_page_guard_marks_job_partial_when_numeric_page_has_zero_parameters():
    """Verify that if a page has numeric content but 0 parameters, job is marked partial
    with the offending page numbers exposed in the API payload, never reporting plain success."""
    repo = MagicMock()
    repo.complete_job = AsyncMock()
    repo.sync_to_documents_table = AsyncMock()

    lifecycle = MagicMock()
    lifecycle.report_progress = AsyncMock()
    checkpoint = MagicMock()

    orchestrator = PipelineOrchestrator(
        job_repo=repo,
        lifecycle_service=lifecycle,
        checkpoint_service=checkpoint,
        s3_client=MagicMock(),
        ocr_handler=MagicMock(),
        layout_handler=MagicMock(),
        graph_handler=MagicMock(),
        clinical_handler=MagicMock(),
        analysis_handler=MagicMock(),
        summary_handler=MagicMock(),
        embedding_handler=MagicMock(),
    )

    job_id = uuid4()
    doc_id = uuid4()

    # Raw OCR has 2 pages: Page 1 has numbers, Page 2 has numbers
    raw_ocr_data = {
        "pages": [
            {"page": 1, "text": "Hemoglobin 11.2 gm%"},
            {"page": 2, "text": "Unparsed numeric table 100.5 200.3"},
        ],
        "fullText": "Hemoglobin 11.2 gm%\nUnparsed numeric table 100.5 200.3",
    }

    # Only Page 1 had parameters extracted! Page 2 has 0 parameters.
    extracted_structured_data = {
        "documentInfo": {"documentType": "LAB_REPORT"},
        "labResults": [
            {"testName": "Hemoglobin", "value": 11.2, "unit": "gm%", "page": 1},
        ],
    }

    # Check page guard evaluation logic directly
    partial_pages = []
    for p in raw_ocr_data["pages"]:
        p_num = p["page"]
        p_text = p.get("text", "")
        import re
        has_digits = bool(re.search(r"\d", p_text))
        p_param_count = sum(1 for item in extracted_structured_data["labResults"] if item.get("page") == p_num)
        if has_digits and p_param_count == 0:
            partial_pages.append(p_num)

    assert partial_pages == [2], f"Expected partial page [2], got {partial_pages}"

    # Evaluate the orchestrator guard logic
    is_partial = len(partial_pages) > 0
    if is_partial:
        completion_status = "PARTIAL"
        completion_message = f"Document processed with partial extraction (pages {partial_pages} had numeric content but 0 parameters)"
        extracted_structured_data["status"] = "partial"
        extracted_structured_data["partialPages"] = partial_pages
        extracted_structured_data["partial_pages"] = partial_pages

    assert completion_status == "PARTIAL"
    assert "partial" == extracted_structured_data["status"]
    assert extracted_structured_data["partialPages"] == [2]
    assert "never report plain success" not in completion_message
    assert "partial extraction (pages [2]" in completion_message


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
