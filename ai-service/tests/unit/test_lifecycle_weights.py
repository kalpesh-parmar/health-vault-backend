from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.constants.stages import (
    PIPELINE_STAGES_ORDER,
    STAGE_EMBEDDING,
    STAGE_FIELD_EXTRACTION,
    STAGE_OCR_RUNNING,
    STAGE_PARSING,
    STAGE_PROGRESS_WINDOWS,
    STAGE_UPLOADING,
    STAGE_VALIDATING,
)
from app.services.pipeline.lifecycle_service import (
    PipelineLifecycleService,
    calculate_stage_percentage,
    ensure_monotonic_progress,
    get_next_stage,
    get_resume_stage,
    is_stage_completed,
)


def test_stage_percentages_are_monotonically_increasing():
    previous_pct = -1
    for stage in PIPELINE_STAGES_ORDER:
        start_pct, end_pct = STAGE_PROGRESS_WINDOWS[stage]
        assert start_pct >= previous_pct, f"Stage {stage} start {start_pct} regressed from {previous_pct}"
        assert end_pct >= start_pct, f"Stage {stage} end {end_pct} is less than start {start_pct}"
        previous_pct = start_pct


def test_page_progress_calculation_for_single_and_multipage():
    # 1-page document
    pct_1_of_1 = calculate_stage_percentage(STAGE_OCR_RUNNING, page=1, total_pages=1)
    assert pct_1_of_1 == 55  # 15 + 40*(1/1)

    # 4-page document
    pct_page_1 = calculate_stage_percentage(STAGE_OCR_RUNNING, page=1, total_pages=4)
    pct_page_2 = calculate_stage_percentage(STAGE_OCR_RUNNING, page=2, total_pages=4)
    pct_page_3 = calculate_stage_percentage(STAGE_OCR_RUNNING, page=3, total_pages=4)
    pct_page_4 = calculate_stage_percentage(STAGE_OCR_RUNNING, page=4, total_pages=4)

    assert pct_page_1 == 25  # 15 + 40*(1/4)
    assert pct_page_2 == 35  # 15 + 40*(2/4)
    assert pct_page_3 == 45  # 15 + 40*(3/4)
    assert pct_page_4 == 55  # 15 + 40*(4/4)

    assert pct_page_1 < pct_page_2 < pct_page_3 < pct_page_4


def test_progress_never_regresses_backwards():
    # If previous percentage was 60, calculated percentage 45 must not decrease it
    result = ensure_monotonic_progress(previous_pct=60, calculated_pct=45)
    assert result == 60

    # If calculated percentage is higher, it advances
    result = ensure_monotonic_progress(previous_pct=60, calculated_pct=75)
    assert result == 75

    # Cannot exceed 100
    result = ensure_monotonic_progress(previous_pct=95, calculated_pct=110)
    assert result == 100


def test_resume_stage_skips_completed_stages():
    completed = [STAGE_VALIDATING, STAGE_UPLOADING]
    resume_stage = get_resume_stage(completed)
    assert resume_stage == STAGE_OCR_RUNNING

    completed = [STAGE_VALIDATING, STAGE_UPLOADING, STAGE_OCR_RUNNING, STAGE_PARSING]
    resume_stage = get_resume_stage(completed)
    assert resume_stage == "GRAPH_EXTRACTION"

    # All completed
    completed = PIPELINE_STAGES_ORDER
    resume_stage = get_resume_stage(completed)
    assert resume_stage == STAGE_EMBEDDING


def test_get_next_stage_progression():
    assert get_next_stage(STAGE_VALIDATING) == STAGE_UPLOADING
    assert get_next_stage(STAGE_UPLOADING) == STAGE_OCR_RUNNING
    assert get_next_stage(STAGE_EMBEDDING) is None


@pytest.mark.asyncio
async def test_lifecycle_service_updates_db_and_notifies():
    mock_repo = MagicMock()
    mock_repo.update_job_checkpoint = AsyncMock()

    mock_notifier = MagicMock()
    mock_notifier.publish_progress = AsyncMock()

    service = PipelineLifecycleService(mock_repo, mock_notifier)
    job_id = uuid.uuid4()
    file_key = "patient/123/doc.pdf"

    pct = await service.report_progress(
        job_id=job_id,
        file_key=file_key,
        stage=STAGE_FIELD_EXTRACTION,
        stage_status="IN_PROGRESS",
        previous_percentage=60,
        message="Extracting clinical entities",
        completed_stages=[STAGE_VALIDATING, STAGE_UPLOADING, STAGE_OCR_RUNNING, STAGE_PARSING],
        checkpoint_data={"uploaded": True},
    )

    assert pct == 65  # STAGE_FIELD_EXTRACTION window start is 65
    mock_repo.update_job_checkpoint.assert_awaited_once()
    mock_notifier.publish_progress.assert_awaited_once()
