from __future__ import annotations

import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Any
from uuid import UUID

from app.constants.stages import (
    PIPELINE_STAGES_ORDER,
    STAGE_ANALYZING,
    STAGE_EMBEDDING,
    STAGE_FIELD_EXTRACTION,
    STAGE_GRAPH_EXTRACTION,
    STAGE_OCR_RUNNING,
    STAGE_PARSING,
    STAGE_SUMMARIZING,
    STAGE_UPLOADING,
    STAGE_VALIDATING,
    STATUS_COMPLETED,
    STATUS_FAILED,
    STATUS_IN_PROGRESS,
    STATUS_REJECTED,
)
from app.core.errors import (
    NonMedicalDocumentException,
    OcrStageFailureError,
    StageExecutionError,
    sanitize_pipeline_error,
)
from app.infrastructure.db.repositories.job_repository import JobRepository
from app.infrastructure.db.repositories.lab_result_repository import LabResultRepository
from app.infrastructure.db.repositories.intelligence_repository import IntelligenceRepository
from app.infrastructure.storage.s3 import CorruptFileException, S3StorageClient
from app.services.pipeline.analysis_stage import AnalysisStageHandler
from app.services.pipeline.checkpoint_service import CheckpointService
from app.services.pipeline.clinical_stage import ClinicalStageHandler
from app.services.pipeline.embedding_stage import EmbeddingStageHandler
from app.services.pipeline.graph_stage import GraphStageHandler
from app.services.pipeline.layout_stage import LayoutStageHandler
from app.services.pipeline.lifecycle_service import (
    PipelineLifecycleService,
    calculate_stage_percentage,
    ensure_monotonic_progress,
)
from app.services.pipeline.ocr_stage import (
    OcrStageHandler,
    has_ocr_failure_placeholders,
    validate_ocr_result,
)
from app.services.pipeline.summary_stage import SummaryStageHandler
from app.services.pipeline.timing_service import TimingTracker

logger = logging.getLogger(__name__)


class PipelineOrchestrator:
    """Master 9-stage Document Intelligence Pipeline Orchestrator with Checkpoint & Resume Engine."""

    def __init__(
        self,
        job_repo: JobRepository,
        lifecycle_service: PipelineLifecycleService,
        checkpoint_service: CheckpointService,
        s3_client: S3StorageClient,
        ocr_handler: OcrStageHandler,
        layout_handler: LayoutStageHandler,
        graph_handler: GraphStageHandler,
        clinical_handler: ClinicalStageHandler,
        analysis_handler: AnalysisStageHandler,
        summary_handler: SummaryStageHandler,
        embedding_handler: EmbeddingStageHandler,
        lab_result_repo: LabResultRepository | None = None,
        intelligence_repo: IntelligenceRepository | None = None,
    ) -> None:
        self.repo = job_repo
        self.lifecycle = lifecycle_service
        self.checkpoint = checkpoint_service
        self.s3_client = s3_client
        self.ocr_handler = ocr_handler
        self.layout_handler = layout_handler
        self.graph_handler = graph_handler
        self.clinical_handler = clinical_handler
        self.analysis_handler = analysis_handler
        self.summary_handler = summary_handler
        self.embedding_handler = embedding_handler
        self.lab_result_repo = lab_result_repo
        self.intelligence_repo = intelligence_repo

    async def _validate_and_restore_checkpoints(
        self,
        job_id: UUID,
        file_key: str,
        bucket: str,
        s3_key: str,
        completed_stages: list[str],
        checkpoint_data: dict[str, Any],
        raw_ocr_data: dict[str, Any] | None,
        extracted_structured_data: dict[str, Any] | None,
        failed_stage: str | None = None,
    ) -> tuple[list[str], dict[str, Any] | None, dict[str, Any] | None, dict[str, Any] | None]:
        """Validates prerequisite checkpoints and restores required stage state from durable storage.

        Prunes any stage that is invalid, missing artifacts, or at/after the failed_stage on retry.
        """
        valid_stages: list[str] = []
        restored_ocr = raw_ocr_data
        restored_layout = None
        restored_structured = extracted_structured_data

        cutoff_idx = len(PIPELINE_STAGES_ORDER)
        if failed_stage and failed_stage in PIPELINE_STAGES_ORDER:
            cutoff_idx = PIPELINE_STAGES_ORDER.index(failed_stage)

        for idx, stage in enumerate(PIPELINE_STAGES_ORDER):
            if idx >= cutoff_idx:
                break
            if stage not in completed_stages:
                break

            if stage == STAGE_VALIDATING:
                valid_stages.append(stage)
            elif stage == STAGE_UPLOADING:
                valid_stages.append(stage)
            elif stage == STAGE_OCR_RUNNING:
                try:
                    restored_ocr = await self.checkpoint.load_raw_ocr_data(
                        raw_ocr_data=restored_ocr,
                        checkpoint_data=checkpoint_data,
                        file_key=file_key,
                        bucket=bucket,
                    )
                    validate_ocr_result(restored_ocr)
                    valid_stages.append(stage)
                except Exception as ocr_val_err:
                    logger.warning(
                        "Job %s checkpoint for %s failed validation: %s. Pruning downstream stages.",
                        job_id,
                        stage,
                        ocr_val_err,
                    )
                    break
            elif stage == STAGE_PARSING:
                restored_layout = checkpoint_data.get(STAGE_PARSING)
                if not restored_layout:
                    try:
                        restored_layout = await self.checkpoint.load_stage_artifact(
                            checkpoint_data, STAGE_PARSING
                        )
                    except Exception:
                        pass
                valid_stages.append(stage)
            elif stage == STAGE_GRAPH_EXTRACTION:
                valid_stages.append(stage)
            elif stage == STAGE_FIELD_EXTRACTION:
                try:
                    restored_structured = await self.checkpoint.load_extracted_structured_data(
                        extracted_data=restored_structured,
                        checkpoint_data=checkpoint_data,
                    )
                    valid_stages.append(stage)
                except Exception as struct_val_err:
                    logger.warning(
                        "Job %s checkpoint for %s failed validation: %s. Pruning downstream stages.",
                        job_id,
                        stage,
                        struct_val_err,
                    )
                    break
            elif stage == STAGE_ANALYZING:
                valid_stages.append(stage)
            elif stage == STAGE_SUMMARIZING:
                valid_stages.append(stage)
            elif stage == STAGE_EMBEDDING:
                valid_stages.append(stage)

        return valid_stages, restored_ocr, restored_layout, restored_structured

    async def _handle_stage_failure(
        self,
        job_id: UUID,
        file_key: str,
        stage: str,
        exc: Exception,
        current_pct: int,
        completed_stages: list[str],
        checkpoint_data: dict[str, Any],
        attempt_count: int,
        document_id: UUID | None = None,
    ) -> None:
        """Handles stage failure: persists status FAILED with exact stage and emits terminal SSE event."""
        logger.error(
            "Job %s failed at mandatory stage %s (attempt=%d): %s",
            job_id,
            stage,
            attempt_count,
            exc,
            exc_info=True,
        )
        if isinstance(exc, StageExecutionError):
            error_code = exc.error_code
            retryable = exc.retryable
            error_msg = exc.message
            details = exc.stage_details or {}
        elif isinstance(exc, NonMedicalDocumentException):
            logger.warning("Job %s rejected: Non-medical document: %s", job_id, exc)
            await self.repo.reject_job(job_id=job_id, reason=str(exc))
            await self.lifecycle.notifier.publish_progress(
                job_id=job_id,
                file_key=file_key,
                stage=stage,
                stage_status=STATUS_REJECTED,
                progress=current_pct,
                percentage=current_pct,
                message=str(exc),
                document_id=document_id,
            )
            return
        elif isinstance(exc, CorruptFileException):
            logger.error("Job %s rejected: Corrupt file: %s", job_id, exc)
            await self.repo.reject_job(job_id=job_id, reason=str(exc))
            await self.lifecycle.notifier.publish_progress(
                job_id=job_id,
                file_key=file_key,
                stage=stage,
                stage_status=STATUS_REJECTED,
                progress=current_pct,
                percentage=current_pct,
                message=str(exc),
                document_id=document_id,
            )
            return
        else:
            error_code = getattr(exc, "error_code", f"{stage}_EXECUTION_FAILED")
            retryable = getattr(exc, "retryable", True)
            error_msg = str(exc) or f"Stage {stage} execution failed"
            details = {}

        sanitized_error = sanitize_pipeline_error(error_msg if isinstance(exc, StageExecutionError) else exc)
        if sanitized_error == "DATABASE_ERROR":
            error_code = "DATABASE_ERROR"
            error_msg = "DATABASE_ERROR"
        else:
            error_msg = sanitized_error

        requires_reupload = bool(getattr(exc, "requires_reupload", not retryable))

        # 1. Persist status FAILED with exact failed stage, error details, attempt_count
        await self.repo.fail_job(
            job_id=job_id,
            error=error_msg,
            failed_stage=stage,
            completed_stages=completed_stages,
            checkpoint_data=checkpoint_data,
            error_code=error_code,
            retryable=retryable,
            requires_reupload=requires_reupload,
            attempt_count=attempt_count,
            stage_details=details,
        )

        # 2. Emit terminal FAILED event through SSE
        await self.lifecycle.notifier.publish_progress(
            job_id=job_id,
            file_key=file_key,
            stage=stage,
            stage_status=STATUS_FAILED,
            progress=current_pct,
            percentage=current_pct,
            message=error_msg,
            document_id=document_id,
            error_code=error_code,
            failed_stage=stage,
            retryable=retryable,
            requires_reupload=requires_reupload,
            attempt_count=attempt_count,
        )

    async def process_job(self, job: dict[str, Any]) -> None:
        job_id = UUID(str(job["id"]))
        file_key = str(job["file_key"])
        checkpoint_data = dict(job.get("checkpoint_data") or {})
        completed_stages = list(job.get("completed_stages") or [])
        current_pct = int(job.get("percentage") or 0)
        attempt_count = int(job.get("attempt_count") or job.get("attemptCount") or 1)
        failed_stage = job.get("failed_stage") or checkpoint_data.get("failedStage")

        metadata = job.get("metadata") or {}
        preferred_language = metadata.get("preferredLanguage") or "english"
        raw_patient_id = (
            job.get("user_id")
            or job.get("patient_id")
            or (metadata.get("patientId") if metadata else None)
            or (metadata.get("userId") if metadata else None)
        )
        patient_id = UUID(str(raw_patient_id)) if raw_patient_id else None
        raw_doc_id = (
            job.get("document_id")
            or job.get("documentId")
            or checkpoint_data.get("documentId")
            or metadata.get("documentId")
        )
        document_id = UUID(str(raw_doc_id)) if raw_doc_id else None
        expected_sha256 = metadata.get("sha256")
        bucket = checkpoint_data.get("s3Bucket") or getattr(
            self.s3_client.settings, "aws_bucket_name", "health-vault-documents"
        )
        s3_key = (
            checkpoint_data.get("s3Key")
            or metadata.get("key")
            or metadata.get("s3Key")
            or file_key
        )

        logger.info(
            "Starting pipeline orchestration for job %s (fileKey=%s, s3Key=%s, attempt=%d, completed=%s, failedStage=%s)",
            job_id,
            file_key,
            s3_key,
            attempt_count,
            completed_stages,
            failed_stage,
        )

        temp_path: Path | None = None
        raw_ocr_data = job.get("raw_ocr_data")
        layout_data = None
        extracted_structured_data = job.get("extracted_structured_data")

        # Validate and restore checkpoints from durable storage
        (
            completed_stages,
            raw_ocr_data,
            layout_data,
            extracted_structured_data,
        ) = await self._validate_and_restore_checkpoints(
            job_id=job_id,
            file_key=file_key,
            bucket=bucket,
            s3_key=s3_key,
            completed_stages=completed_stages,
            checkpoint_data=checkpoint_data,
            raw_ocr_data=raw_ocr_data,
            extracted_structured_data=extracted_structured_data,
            failed_stage=failed_stage,
        )

        try:
            # ─────────────────────────────────────────────────────────────────
            # 1. STAGE: VALIDATING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_VALIDATING not in completed_stages:
                try:
                    temp_path = await self.ocr_handler.verify_upload(
                        bucket=bucket, key=s3_key, expected_sha256=expected_sha256
                    )
                    file_bytes = await asyncio.to_thread(temp_path.read_bytes)
                    validation_res = await self.ocr_handler.validate_document(
                        file_bytes=file_bytes,
                        filename=metadata.get("originalName") or s3_key.split("/")[-1] or file_key,
                        mime_type=metadata.get("mimeType")
                    )

                    completed_stages.append(STAGE_VALIDATING)
                    current_pct = ensure_monotonic_progress(
                        current_pct, calculate_stage_percentage(STAGE_VALIDATING)
                    )
                    checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                        job_id=job_id,
                        file_key=file_key,
                        bucket=bucket,
                        stage=STAGE_VALIDATING,
                        progress_pct=current_pct,
                        message="Document validation successful",
                        stage_data=validation_res,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                    )
                    await self.lifecycle.report_progress(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_VALIDATING,
                        stage_status=STATUS_IN_PROGRESS,
                        previous_percentage=current_pct,
                        message="Document validated",
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                    )
                except Exception as exc:
                    await self._handle_stage_failure(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_VALIDATING,
                        exc=exc,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                        document_id=document_id,
                    )
                    return

            # ─────────────────────────────────────────────────────────────────
            # 2. STAGE: UPLOADING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_UPLOADING not in completed_stages:
                try:
                    if not temp_path or not temp_path.exists():
                        temp_path = await self.ocr_handler.verify_upload(
                            bucket=bucket, key=s3_key, expected_sha256=expected_sha256
                        )

                    upload_res = {
                        "uploaded": True,
                        "s3Bucket": bucket,
                        "s3Key": s3_key,
                        "sha256Verified": bool(expected_sha256),
                    }

                    completed_stages.append(STAGE_UPLOADING)
                    current_pct = ensure_monotonic_progress(
                        current_pct, calculate_stage_percentage(STAGE_UPLOADING)
                    )
                    checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                        job_id=job_id,
                        file_key=file_key,
                        bucket=bucket,
                        stage=STAGE_UPLOADING,
                        progress_pct=current_pct,
                        message="Storage pointer verified",
                        stage_data=upload_res,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                    )
                    await self.lifecycle.report_progress(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_UPLOADING,
                        stage_status=STATUS_IN_PROGRESS,
                        previous_percentage=current_pct,
                        message="Storage pointer verified",
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                    )
                except Exception as exc:
                    await self._handle_stage_failure(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_UPLOADING,
                        exc=exc,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                        document_id=document_id,
                    )
                    return

            # ─────────────────────────────────────────────────────────────────
            # 3. STAGE: OCR_RUNNING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_OCR_RUNNING not in completed_stages:
                try:
                    if not temp_path or not temp_path.exists():
                        temp_path = await self.ocr_handler.verify_upload(
                            bucket=bucket, key=s3_key, expected_sha256=expected_sha256
                        )

                    raw_ocr_data = await self.ocr_handler.run_ocr(
                        file_path=temp_path,
                        filename=metadata.get("originalName") or s3_key.split("/")[-1] or file_key,
                        job_id=job_id,
                        file_key=file_key,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                    )

                    # Validate OCR result (detects page failures, placeholders, unreadable text)
                    validate_ocr_result(raw_ocr_data)

                    completed_stages.append(STAGE_OCR_RUNNING)
                    current_pct = ensure_monotonic_progress(
                        current_pct, calculate_stage_percentage(STAGE_OCR_RUNNING)
                    )
                    checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                        job_id=job_id,
                        file_key=file_key,
                        bucket=bucket,
                        stage=STAGE_OCR_RUNNING,
                        progress_pct=current_pct,
                        message=f"OCR completed ({raw_ocr_data.get('pageCount', 1)} pages)",
                        stage_data={"pageCount": raw_ocr_data.get("pageCount", 1)},
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        raw_ocr_data=raw_ocr_data,
                        attempt_count=attempt_count,
                    )
                    await self.lifecycle.report_progress(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_OCR_RUNNING,
                        stage_status=STATUS_IN_PROGRESS,
                        previous_percentage=current_pct,
                        message="Text extraction completed",
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        raw_ocr_data=raw_ocr_data,
                    )
                except Exception as exc:
                    await self._handle_stage_failure(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_OCR_RUNNING,
                        exc=exc,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                        document_id=document_id,
                    )
                    return
            elif not raw_ocr_data:
                raw_ocr_data = await self.checkpoint.load_raw_ocr_data(
                    raw_ocr_data=None,
                    checkpoint_data=checkpoint_data,
                    file_key=file_key,
                    bucket=bucket,
                )

            # ─────────────────────────────────────────────────────────────────
            # 4. STAGE: PARSING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_PARSING not in completed_stages:
                try:
                    layout_data = self.layout_handler.parse_layout(raw_ocr_data or {})

                    completed_stages.append(STAGE_PARSING)
                    current_pct = ensure_monotonic_progress(
                        current_pct, calculate_stage_percentage(STAGE_PARSING)
                    )
                    checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                        job_id=job_id,
                        file_key=file_key,
                        bucket=bucket,
                        stage=STAGE_PARSING,
                        progress_pct=current_pct,
                        message="Layout and tables decomposed",
                        stage_data=layout_data,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                    )
                    await self.lifecycle.report_progress(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_PARSING,
                        stage_status=STATUS_IN_PROGRESS,
                        previous_percentage=current_pct,
                        message="Layout and tables parsed",
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                    )
                except Exception as exc:
                    await self._handle_stage_failure(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_PARSING,
                        exc=exc,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                        document_id=document_id,
                    )
                    return
            elif not layout_data:
                layout_data = await self.checkpoint.load_stage_artifact(
                    checkpoint_data, STAGE_PARSING
                )

            # ─────────────────────────────────────────────────────────────────
            # 5. STAGE: GRAPH_EXTRACTION
            # ─────────────────────────────────────────────────────────────────
            if STAGE_GRAPH_EXTRACTION not in completed_stages:
                try:
                    if not temp_path or not temp_path.exists():
                        temp_path = await self.ocr_handler.verify_upload(
                            bucket=bucket, key=s3_key, expected_sha256=expected_sha256
                        )

                    graphs_data = await self.graph_handler.extract_graphs(
                        file_path=temp_path,
                        file_key=file_key,
                        bucket=bucket,
                        raw_ocr_data=raw_ocr_data,
                    )

                    completed_stages.append(STAGE_GRAPH_EXTRACTION)
                    current_pct = ensure_monotonic_progress(
                        current_pct, calculate_stage_percentage(STAGE_GRAPH_EXTRACTION)
                    )
                    checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                        job_id=job_id,
                        file_key=file_key,
                        bucket=bucket,
                        stage=STAGE_GRAPH_EXTRACTION,
                        progress_pct=current_pct,
                        message=f"Extracted {len(graphs_data)} visual graphs / strips",
                        stage_data={"graphs": graphs_data},
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                    )
                    await self.lifecycle.report_progress(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_GRAPH_EXTRACTION,
                        stage_status=STATUS_IN_PROGRESS,
                        previous_percentage=current_pct,
                        message="Visual graphs and charts extracted",
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                    )
                except Exception as exc:
                    await self._handle_stage_failure(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_GRAPH_EXTRACTION,
                        exc=exc,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                        document_id=document_id,
                    )
                    return

            # ─────────────────────────────────────────────────────────────────
            # 6. STAGE: FIELD_EXTRACTION
            # ─────────────────────────────────────────────────────────────────
            if STAGE_FIELD_EXTRACTION not in completed_stages:
                try:
                    extracted_structured_data = await self.clinical_handler.extract_fields(
                        raw_ocr_data=raw_ocr_data or {},
                        layout_data=layout_data,
                    )

                    # Persist evaluated lab results into relational patient_lab_results
                    if self.lab_result_repo is not None and extracted_structured_data:
                        raw_labs = extracted_structured_data.get("labResults") or []
                        target_user_id = (
                            job.get("user_id")
                            or (metadata.get("userId") if metadata else None)
                            or (metadata.get("patientId") if metadata else None)
                        )
                        if target_user_id and raw_labs:
                            try:
                                user_uuid = UUID(str(target_user_id))
                                doc_date = (
                                    extracted_structured_data.get("documentInfo", {}).get("date")
                                    or (metadata.get("reportDate") if metadata else None)
                                    )
                                persisted_labs = await self.lab_result_repo.persist_lab_results(
                                    user_id=user_uuid,
                                    document_id=document_id,
                                    report_id=file_key,
                                    lab_items=raw_labs,
                                    test_date=doc_date,
                                )
                                logger.info(
                                    "Persisted %d structured lab results to patient_lab_results (user=%s, doc=%s)",
                                    len(persisted_labs),
                                    user_uuid,
                                    document_id,
                                )
                            except Exception as p_err:
                                logger.error(
                                    "Failed to persist lab results to patient_lab_results: %s",
                                    p_err,
                                    exc_info=True,
                                )

                    completed_stages.append(STAGE_FIELD_EXTRACTION)
                    current_pct = ensure_monotonic_progress(
                        current_pct, calculate_stage_percentage(STAGE_FIELD_EXTRACTION)
                    )
                    checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                        job_id=job_id,
                        file_key=file_key,
                        bucket=bucket,
                        stage=STAGE_FIELD_EXTRACTION,
                        progress_pct=current_pct,
                        message="Clinical entities extracted and lab bounds evaluated",
                        stage_data=extracted_structured_data,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        extracted_structured_data=extracted_structured_data,
                        attempt_count=attempt_count,
                    )
                    await self.lifecycle.report_progress(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_FIELD_EXTRACTION,
                        stage_status=STATUS_IN_PROGRESS,
                        previous_percentage=current_pct,
                        message="Medical entities extracted",
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        extracted_structured_data=extracted_structured_data,
                    )
                except Exception as exc:
                    await self._handle_stage_failure(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_FIELD_EXTRACTION,
                        exc=exc,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                        document_id=document_id,
                    )
                    return
            elif not extracted_structured_data:
                extracted_structured_data = await self.checkpoint.load_extracted_structured_data(
                    extracted_data=None,
                    checkpoint_data=checkpoint_data,
                )

            # ─────────────────────────────────────────────────────────────────
            # 7. STAGE: ANALYZING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_ANALYZING not in completed_stages:
                try:
                    analysis_data = self.analysis_handler.analyze(
                        structured_data=extracted_structured_data or {}
                    )

                    completed_stages.append(STAGE_ANALYZING)
                    current_pct = ensure_monotonic_progress(
                        current_pct, calculate_stage_percentage(STAGE_ANALYZING)
                    )
                    checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                        job_id=job_id,
                        file_key=file_key,
                        bucket=bucket,
                        stage=STAGE_ANALYZING,
                        progress_pct=current_pct,
                        message=f"Safety analysis complete: risk level {analysis_data.get('riskLevel')}",
                        stage_data=analysis_data,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                    )
                    await self.lifecycle.report_progress(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_ANALYZING,
                        stage_status=STATUS_IN_PROGRESS,
                        previous_percentage=current_pct,
                        message="Clinical safety analysis completed",
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                    )
                except Exception as exc:
                    await self._handle_stage_failure(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_ANALYZING,
                        exc=exc,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                        document_id=document_id,
                    )
                    return

            # ─────────────────────────────────────────────────────────────────
            # 8. STAGE: SUMMARIZING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_SUMMARIZING not in completed_stages:
                try:
                    full_text = (raw_ocr_data or {}).get("fullText", "")
                    summary_data = await self.summary_handler.generate_summary(
                        raw_text=full_text,
                        structured_data=extracted_structured_data or {},
                        preferred_language=preferred_language,
                    )
                    if extracted_structured_data is not None and isinstance(summary_data, dict):
                        extracted_structured_data.update({
                            "summaryEnglish": summary_data.get("summaryEnglish"),
                            "summaryInPreferredLanguage": summary_data.get("summaryInPreferredLanguage"),
                            "summaryLanguage": summary_data.get("summaryLanguage"),
                            "preferredLanguage": summary_data.get("preferredLanguage"),
                            "translationStatus": summary_data.get("translationStatus"),
                            "translationProvider": summary_data.get("translationProvider"),
                            "keyPoints": summary_data.get("keyPoints"),
                            "keyFindings": summary_data.get("keyFindings"),
                            "dosagePreserved": summary_data.get("dosagePreserved"),
                        })

                    completed_stages.append(STAGE_SUMMARIZING)
                    current_pct = ensure_monotonic_progress(
                        current_pct, calculate_stage_percentage(STAGE_SUMMARIZING)
                    )
                    checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                        job_id=job_id,
                        file_key=file_key,
                        bucket=bucket,
                        stage=STAGE_SUMMARIZING,
                        progress_pct=current_pct,
                        message="Clinical summary generated and translated",
                        stage_data=summary_data,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        extracted_structured_data=extracted_structured_data,
                        attempt_count=attempt_count,
                    )
                    await self.lifecycle.report_progress(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_SUMMARIZING,
                        stage_status=STATUS_IN_PROGRESS,
                        previous_percentage=current_pct,
                        message="Summary synthesized",
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                    )
                except Exception as exc:
                    await self._handle_stage_failure(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_SUMMARIZING,
                        exc=exc,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                        document_id=document_id,
                    )
                    return
            elif extracted_structured_data and "summaryEnglish" not in extracted_structured_data:
                summary_data = await self.checkpoint.load_stage_artifact(
                    checkpoint_data, STAGE_SUMMARIZING
                )
                if isinstance(summary_data, dict):
                    extracted_structured_data.update({
                        "summaryEnglish": summary_data.get("summaryEnglish"),
                        "summaryInPreferredLanguage": summary_data.get("summaryInPreferredLanguage"),
                        "summaryLanguage": summary_data.get("summaryLanguage"),
                        "preferredLanguage": summary_data.get("preferredLanguage"),
                        "translationStatus": summary_data.get("translationStatus"),
                        "translationProvider": summary_data.get("translationProvider"),
                        "keyPoints": summary_data.get("keyPoints"),
                        "keyFindings": summary_data.get("keyFindings"),
                        "dosagePreserved": summary_data.get("dosagePreserved"),
                    })

            # ─────────────────────────────────────────────────────────────────
            # 9. STAGE: EMBEDDING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_EMBEDDING not in completed_stages:
                try:
                    full_text = (raw_ocr_data or {}).get("fullText", "")
                    embedding_data = await self.embedding_handler.generate_embeddings(
                        full_text=full_text,
                        patient_id=patient_id,
                        document_id=document_id,
                    )

                    chunks = embedding_data.get("chunks") or []
                    persisted_chunk_count = 0
                    persisted_embedding_count = 0

                    if self.intelligence_repo is not None and document_id is not None:
                        persisted_chunk_count, persisted_embedding_count = (
                            await self.intelligence_repo.persist_document_chunks_and_embeddings(
                                document_id=document_id,
                                user_id=patient_id,
                                chunks=chunks,
                                model_name=getattr(self.embedding_handler.embeddings, "model_name", "bge-m3:latest"),
                                expected_dim=getattr(self.embedding_handler.embeddings, "expected_dim", 1024),
                            )
                        )
                    elif chunks and document_id is not None and self.intelligence_repo is None:
                        raise RuntimeError("IntelligenceRepository is not configured; cannot persist document embeddings")

                    completed_stages.append(STAGE_EMBEDDING)
                    current_pct = 100
                    checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                        job_id=job_id,
                        file_key=file_key,
                        bucket=bucket,
                        stage=STAGE_EMBEDDING,
                        progress_pct=current_pct,
                        message="RAG dense vector embeddings generated and persisted",
                        stage_data={
                            "chunkCount": len(chunks),
                            "persistedChunkCount": persisted_chunk_count,
                            "persistedEmbeddingCount": persisted_embedding_count,
                        },
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                    )
                except Exception as exc:
                    await self._handle_stage_failure(
                        job_id=job_id,
                        file_key=file_key,
                        stage=STAGE_EMBEDDING,
                        exc=exc,
                        current_pct=current_pct,
                        completed_stages=completed_stages,
                        checkpoint_data=checkpoint_data,
                        attempt_count=attempt_count,
                        document_id=document_id,
                    )
                    return

            # ─────────────────────────────────────────────────────────────────
            # TERMINAL COMPLETION
            # ─────────────────────────────────────────────────────────────────

            completion_status = "COMPLETED"
            completion_message = "Document processing completed successfully"

            # Remove obsolete PARTIAL metadata.
            if isinstance(extracted_structured_data, dict):

                if extracted_structured_data.get("status") == "partial":
                    extracted_structured_data.pop("status", None)

                extracted_structured_data.pop("partialPages", None)
                extracted_structured_data.pop("partial_pages", None)

                warning = extracted_structured_data.get("warning")

                if isinstance(warning, str) and warning.startswith(
                    "Document processed with partial extraction"
                ):
                    extracted_structured_data.pop("warning", None)

            # Synchronize extracted results with the documents table.
            # A synchronization failure must not produce a successful completion.
            if document_id:
                await self.repo.sync_to_documents_table(
                    document_id=document_id,
                    extracted_structured_data=extracted_structured_data,
                    raw_ocr_data=raw_ocr_data,
                )

            # Persist terminal job state only after synchronization succeeds.
            completed_ok = await self.repo.complete_job(
                job_id=job_id,
                message=completion_message,
                completed_stages=completed_stages,
                checkpoint_data=checkpoint_data,
                raw_ocr_data=raw_ocr_data,
                extracted_structured_data=extracted_structured_data,
                status=completion_status,
                attempt_count=attempt_count,
            )

            if completed_ok is False and attempt_count is not None:
                logger.warning(
                    "Job %s terminal completion skipped: row not updated (lease lost or status changed).",
                    job_id,
                )
                return

            current_pct = 100

            await self.lifecycle.report_progress(
                job_id=job_id,
                file_key=file_key,
                stage=STAGE_EMBEDDING,
                stage_status=STATUS_COMPLETED,
                previous_percentage=current_pct,
                message=completion_message,
                completed_stages=completed_stages,
                checkpoint_data=checkpoint_data,
                document_id=document_id,
            )

            logger.info("Job %s finished with status %s (100%%).",job_id,completion_status)

        except Exception as err:
            logger.exception("Job %s encountered unexpected error outside stage blocks: %s", job_id, err)
            fallback_stage = completed_stages[-1] if completed_stages else STAGE_VALIDATING
            await self._handle_stage_failure(
                job_id=job_id,
                file_key=file_key,
                stage=fallback_stage,
                exc=err,
                current_pct=current_pct,
                completed_stages=completed_stages,
                checkpoint_data=checkpoint_data,
                attempt_count=attempt_count,
                document_id=document_id,
            )
        finally:
            if temp_path and temp_path.exists():
                try:
                    temp_path.unlink()
                except Exception:
                    pass
