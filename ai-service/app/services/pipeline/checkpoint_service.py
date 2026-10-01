from __future__ import annotations

import json
import logging
from typing import Any
from uuid import UUID

from app.infrastructure.db.repositories.job_repository import JobRepository
from app.infrastructure.storage.s3 import S3StorageClient

logger = logging.getLogger(__name__)

# 500 KB limit for inline database JSON fields (PRD Section 7 / Task 3.3)
LARGE_ARTIFACT_THRESHOLD_BYTES = 500 * 1024


class CheckpointService:
    """Manages cross-cutting stage checkpointing and offloading large (>500KB) artifacts to S3."""

    def __init__(self, job_repo: JobRepository, s3_client: S3StorageClient) -> None:
        self.repo = job_repo
        self.s3_client = s3_client

    async def persist_stage_checkpoint(
        self,
        job_id: UUID,
        file_key: str,
        bucket: str,
        stage: str,
        progress_pct: int,
        message: str,
        stage_data: dict[str, Any],
        completed_stages: list[str],
        checkpoint_data: dict[str, Any],
        raw_ocr_data: dict[str, Any] | None = None,
        extracted_structured_data: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        """Persists stage data. Offloads to S3 if payload exceeds 500KB."""
        updated_checkpoint = dict(checkpoint_data)

        # Check size of stage_data
        encoded_data = json.dumps(stage_data, ensure_ascii=False).encode("utf-8")
        if len(encoded_data) > LARGE_ARTIFACT_THRESHOLD_BYTES:
            s3_key = f"{file_key}.{stage.lower()}.json"
            logger.info(
                "Checkpoint payload for stage %s exceeds 500KB (%d bytes). Offloading to s3://%s/%s",
                stage,
                len(encoded_data),
                bucket,
                s3_key,
            )
            await self.s3_client.upload_json_artifact(bucket=bucket, key=s3_key, data=stage_data)
            updated_checkpoint[stage] = {
                "_s3_ref": True,
                "s3Bucket": bucket,
                "s3Key": s3_key,
                "sizeBytes": len(encoded_data),
            }
        else:
            updated_checkpoint[stage] = stage_data

        # Check raw_ocr_data size if provided
        persisted_raw_ocr = raw_ocr_data
        if raw_ocr_data:
            raw_bytes = json.dumps(raw_ocr_data, ensure_ascii=False).encode("utf-8")
            if len(raw_bytes) > LARGE_ARTIFACT_THRESHOLD_BYTES:
                ocr_s3_key = f"{file_key}.ocr.json"
                logger.info(
                    "Raw OCR data exceeds 500KB (%d bytes). Offloading to s3://%s/%s",
                    len(raw_bytes),
                    bucket,
                    ocr_s3_key,
                )
                await self.s3_client.upload_json_artifact(bucket=bucket, key=ocr_s3_key, data=raw_ocr_data)
                persisted_raw_ocr = {
                    "_s3_ref": True,
                    "s3Bucket": bucket,
                    "s3Key": ocr_s3_key,
                    "pageCount": raw_ocr_data.get("pageCount", 0),
                    "confidence": raw_ocr_data.get("confidence", 1.0),
                }

        # Update database row
        await self.repo.update_job_checkpoint(
            job_id=job_id,
            stage=stage,
            stage_status="IN_PROGRESS",
            percentage=progress_pct,
            message=message,
            completed_stages=completed_stages,
            checkpoint_data=updated_checkpoint,
            raw_ocr_data=persisted_raw_ocr,
            extracted_structured_data=extracted_structured_data,
        )

        return updated_checkpoint

    async def load_stage_artifact(
        self,
        checkpoint_data: dict[str, Any],
        stage: str,
    ) -> dict[str, Any] | None:
        """Loads stage data, resolving S3 artifact references if offloaded."""
        data = checkpoint_data.get(stage)
        if not data or not isinstance(data, dict):
            return data

        if data.get("_s3_ref") and data.get("s3Key") and data.get("s3Bucket"):
            bucket = data["s3Bucket"]
            key = data["s3Key"]
            logger.info("Resolving offloaded checkpoint artifact from s3://%s/%s", bucket, key)
            raw_bytes = await self.s3_client.read_bytes(bucket=bucket, key=key)
            return json.loads(raw_bytes.decode("utf-8"))

        return data
