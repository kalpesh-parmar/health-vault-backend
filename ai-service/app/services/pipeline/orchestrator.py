from __future__ import annotations

import asyncio
import logging
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
from app.core.errors import NonMedicalDocumentException
from app.infrastructure.db.repositories.job_repository import JobRepository
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
from app.services.pipeline.ocr_stage import OcrStageHandler
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

    async def process_job(self, job: dict[str, Any]) -> None:
        job_id = UUID(str(job["id"]))
        file_key = str(job["file_key"])
        checkpoint_data = dict(job.get("checkpoint_data") or {})
        completed_stages = list(job.get("completed_stages") or [])
        current_pct = int(job.get("percentage") or 0)

        metadata = job.get("metadata") or {}
        preferred_language = metadata.get("preferredLanguage") or "english"
        patient_id = UUID(str(metadata["patientId"])) if metadata.get("patientId") else None
        raw_doc_id = checkpoint_data.get("documentId") or metadata.get("documentId")
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
            "Starting pipeline orchestration for job %s (fileKey=%s, s3Key=%s, completed=%s)",
            job_id,
            file_key,
            s3_key,
            completed_stages,
        )

        temp_path: Path | None = None
        raw_ocr_data = job.get("raw_ocr_data")
        layout_data = None
        extracted_structured_data = job.get("extracted_structured_data")

        try:
            # ─────────────────────────────────────────────────────────────────
            # 1. STAGE: VALIDATING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_VALIDATING not in completed_stages:
                print("\n\n [KP] ******************** VALIDATING ******************** \n\n")   
                # If we don't have file yet, stream probe from S3 or download
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

            # ─────────────────────────────────────────────────────────────────
            # 2. STAGE: UPLOADING
            # ─────────────────────────────────────────────────────────────────
            print("\n\n [KP] ******************** UPLOADING ******************** \n\n")
            if STAGE_UPLOADING not in completed_stages:
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

            # ─────────────────────────────────────────────────────────────────
            # 3. STAGE: OCR_RUNNING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_OCR_RUNNING not in completed_stages:
                print("\n\n [KP] ******************** OCR_RUNNING ******************** \n\n")   
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
            elif not raw_ocr_data:
                raw_ocr_data = await self.checkpoint.load_stage_artifact(
                    checkpoint_data, STAGE_OCR_RUNNING
                )

            # ─────────────────────────────────────────────────────────────────
            # 4. STAGE: PARSING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_PARSING not in completed_stages:
                print("\n\n [KP] ******************** PARSING ******************** \n\n")
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
            elif not layout_data:
                layout_data = await self.checkpoint.load_stage_artifact(
                    checkpoint_data, STAGE_PARSING
                )
            
            # ─────────────────────────────────────────────────────────────────
            # 5. STAGE: GRAPH_EXTRACTION
            # ─────────────────────────────────────────────────────────────────
            if STAGE_GRAPH_EXTRACTION not in completed_stages:
                print("\n\n [KP] ******************** GRAPH_EXTRACTION ******************** \n\n")
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

            # ─────────────────────────────────────────────────────────────────
            # 6. STAGE: FIELD_EXTRACTION
            # ─────────────────────────────────────────────────────────────────
            if STAGE_FIELD_EXTRACTION not in completed_stages:
                print("\n\n [KP] ******************** FIELD_EXTRACTION ******************** \n\n")
                extracted_structured_data = await self.clinical_handler.extract_fields(
                    raw_ocr_data=raw_ocr_data or {},
                    layout_data=layout_data,
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
            elif not extracted_structured_data:
                extracted_structured_data = await self.checkpoint.load_stage_artifact(
                    checkpoint_data, STAGE_FIELD_EXTRACTION
                )

            # ─────────────────────────────────────────────────────────────────
            # 7. STAGE: ANALYZING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_ANALYZING not in completed_stages:
                print("\n\n [KP] ******************** ANALYZING ******************** \n\n")
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

            # ─────────────────────────────────────────────────────────────────
            # 8. STAGE: SUMMARIZING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_SUMMARIZING not in completed_stages:
                print("\n\n [KP] ******************** SUMMARIZING ******************** \n\n")
                full_text = (raw_ocr_data or {}).get("fullText", "")
                summary_data = await self.summary_handler.generate_summary(
                    raw_text=full_text,
                    structured_data=extracted_structured_data or {},
                    preferred_language=preferred_language,
                )

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

            # ─────────────────────────────────────────────────────────────────
            # 9. STAGE: EMBEDDING
            # ─────────────────────────────────────────────────────────────────
            if STAGE_EMBEDDING not in completed_stages:
                print("\n\n [KP] ******************** EMBEDDING ******************** \n\n")
                full_text = (raw_ocr_data or {}).get("fullText", "")
                embedding_data = await self.embedding_handler.generate_embeddings(
                    full_text=full_text,
                    patient_id=patient_id,
                    document_id=document_id,
                )

                completed_stages.append(STAGE_EMBEDDING)
                current_pct = 100
                checkpoint_data = await self.checkpoint.persist_stage_checkpoint(
                    job_id=job_id,
                    file_key=file_key,
                    bucket=bucket,
                    stage=STAGE_EMBEDDING,
                    progress_pct=current_pct,
                    message="RAG dense vector embeddings generated",
                    stage_data={"chunkCount": embedding_data.get("chunkCount", 0)},
                    completed_stages=completed_stages,
                    checkpoint_data=checkpoint_data,
                )

            # ─────────────────────────────────────────────────────────────────
            # TERMINAL COMPLETION
            # ─────────────────────────────────────────────────────────────────
            print("\n\n [KP] ******************** COMPLETE ******************** \n\n")
            await self.repo.complete_job(
                job_id=job_id,
                message="Document processing completed successfully",
                completed_stages=completed_stages,
                checkpoint_data=checkpoint_data,
                raw_ocr_data=raw_ocr_data,
                extracted_structured_data=extracted_structured_data,
            )
            if document_id:
                try:
                    await self.repo.sync_to_documents_table(
                        document_id=document_id,
                        extracted_structured_data=extracted_structured_data,
                        raw_ocr_data=raw_ocr_data,
                    )
                except Exception as sync_err:
                    logger.warning(
                        "Failed to sync completed job to documents table (documentId=%s): %s",
                        document_id,
                        sync_err,
                    )

            await self.lifecycle.report_progress(
                job_id=job_id,
                file_key=file_key,
                stage=STAGE_EMBEDDING,
                stage_status=STATUS_COMPLETED,
                previous_percentage=100,
                message="Document processing complete",
                completed_stages=completed_stages,
                checkpoint_data=checkpoint_data,
                document_id=document_id,
            )
            logger.info("Job %s completed successfully (100%%).", job_id)

        except NonMedicalDocumentException as nme:
            logger.warning("Job %s rejected: Non-medical document: %s", job_id, nme)
            await self.repo.reject_job(job_id=job_id, reason=str(nme))
            await self.lifecycle.notifier.publish_progress(
                job_id=job_id,
                file_key=file_key,
                stage=STAGE_VALIDATING,
                stage_status=STATUS_REJECTED,
                progress=current_pct,
                percentage=current_pct,
                message=str(nme),
            )
        except CorruptFileException as cfe:
            logger.error("Job %s rejected: Corrupt file: %s", job_id, cfe)
            await self.repo.reject_job(job_id=job_id, reason=str(cfe))
            await self.lifecycle.notifier.publish_progress(
                job_id=job_id,
                file_key=file_key,
                stage=STAGE_UPLOADING,
                stage_status=STATUS_REJECTED,
                progress=current_pct,
                percentage=current_pct,
                message=str(cfe),
            )
        except Exception as err:
            logger.exception("Job %s failed during pipeline execution: %s", job_id, err)
            await self.repo.fail_job(job_id=job_id, error=str(err))
            await self.lifecycle.notifier.publish_progress(
                job_id=job_id,
                file_key=file_key,
                stage=completed_stages[-1] if completed_stages else STAGE_VALIDATING,
                stage_status=STATUS_FAILED,
                progress=current_pct,
                percentage=current_pct,
                message=f"Processing failed: {err}",
            )
            raise
        finally:
            if temp_path and temp_path.exists():
                try:
                    temp_path.unlink()
                except Exception:
                    pass
