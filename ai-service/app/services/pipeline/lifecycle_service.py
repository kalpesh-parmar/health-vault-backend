from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

from app.constants.stages import (
    PIPELINE_STAGES_ORDER,
    STAGE_EMBEDDING,
    STAGE_OCR_RUNNING,
    STAGE_PROGRESS_WINDOWS,
    STAGE_QUEUED,
    STATUS_COMPLETED,
    STATUS_IN_PROGRESS,
)
from app.infrastructure.db.repositories.job_repository import JobRepository
from app.services.notifier import ProgressNotifier

logger = logging.getLogger(__name__)


def calculate_stage_percentage(
    stage: str, page: int | None = None, total_pages: int | None = None
) -> int:
    window = STAGE_PROGRESS_WINDOWS.get(stage, (0, 0))
    start_pct, end_pct = window

    if stage == STAGE_OCR_RUNNING and page is not None and total_pages is not None and total_pages > 0:
        ratio = min(page, total_pages) / total_pages
        interpolated = start_pct + int((end_pct - start_pct) * ratio)
        return min(end_pct, max(start_pct, interpolated))

    return start_pct


def ensure_monotonic_progress(previous_pct: int, calculated_pct: int) -> int:
    return max(previous_pct, min(100, calculated_pct))


def get_next_stage(current_stage: str) -> str | None:
    if current_stage == STAGE_QUEUED:
        return PIPELINE_STAGES_ORDER[0]

    try:
        idx = PIPELINE_STAGES_ORDER.index(current_stage)
        if idx + 1 < len(PIPELINE_STAGES_ORDER):
            return PIPELINE_STAGES_ORDER[idx + 1]
        return None
    except ValueError:
        return PIPELINE_STAGES_ORDER[0]


def get_resume_stage(completed_stages: list[str]) -> str:
    completed_set = set(completed_stages)
    for stage in PIPELINE_STAGES_ORDER:
        if stage not in completed_set:
            return stage
    return STAGE_EMBEDDING


def is_stage_completed(stage: str, completed_stages: list[str]) -> bool:
    return stage in completed_stages


class PipelineLifecycleService:
    def __init__(
        self,
        job_repo: JobRepository,
        notifier: ProgressNotifier,
    ) -> None:
        self.repo = job_repo
        self.notifier = notifier

    async def report_progress(
        self,
        job_id: UUID,
        file_key: str,
        stage: str,
        stage_status: str,
        previous_percentage: int,
        message: str,
        completed_stages: list[str],
        checkpoint_data: dict[str, Any],
        document_id: UUID | str | None = None,
        page: int | None = None,
        total_pages: int | None = None,
        detected_languages: list[str] | None = None,
        raw_ocr_data: dict[str, Any] | None = None,
        extracted_structured_data: dict[str, Any] | None = None,
    ) -> int:
        calculated_pct = calculate_stage_percentage(stage, page=page, total_pages=total_pages)
        monotonic_pct = ensure_monotonic_progress(previous_percentage, calculated_pct)

        # 1. Update database checkpoint state
        await self.repo.update_job_checkpoint(
            job_id=job_id,
            stage=stage,
            stage_status=stage_status,
            percentage=monotonic_pct,
            message=message,
            completed_stages=completed_stages,
            checkpoint_data=checkpoint_data,
            raw_ocr_data=raw_ocr_data,
            extracted_structured_data=extracted_structured_data,
        )

        # 2. Publish zero-PHI progress notification over PostgreSQL channel
        doc_id = document_id or checkpoint_data.get("documentId")
        await self.notifier.publish_progress(
            job_id=job_id,
            file_key=file_key,
            stage=stage,
            stage_status=stage_status,
            progress=monotonic_pct,
            percentage=monotonic_pct,
            message=message,
            document_id=doc_id,
            page=page,
            total_pages=total_pages,
            detected_languages=detected_languages,
        )

        return monotonic_pct
