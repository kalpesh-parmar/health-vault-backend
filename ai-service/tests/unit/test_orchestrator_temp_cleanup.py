import tempfile
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.services.pipeline.orchestrator import PipelineOrchestrator


@pytest.mark.asyncio
async def test_orchestrator_cleanup_only_unlinks_temp_file_never_storage(monkeypatch):
    """
    Check 4: Prove production orchestrator only deletes its own temp copies,
    never stored or original files in S3 or persistent storage.
    """
    # 1. Create a simulated temporary download file
    with tempfile.NamedTemporaryFile(delete=False, suffix="_temp_download.pdf") as tf:
        temp_file_path = Path(tf.name)
        temp_file_path.write_bytes(b"%PDF-1.4 simulated temp download")

    # 2. Create a persistent source file to ensure it remains untouched
    with tempfile.NamedTemporaryFile(delete=False, suffix="_persistent_source.pdf") as sf:
        persistent_source_path = Path(sf.name)
        persistent_source_path.write_bytes(b"%PDF-1.4 persistent original storage")

    try:
        assert temp_file_path.exists()
        assert persistent_source_path.exists()

        # Mock S3 and pipeline dependencies
        mock_s3 = MagicMock()
        mock_s3.delete_object = MagicMock()
        mock_s3.delete_objects = MagicMock()
        mock_s3.settings = MagicMock()
        mock_s3.settings.aws_bucket_name = "health-vault-uploads"

        mock_ocr = MagicMock()
        mock_ocr.validate_document = AsyncMock(return_value={"isValid": True})
        mock_ocr.verify_upload = AsyncMock(return_value=temp_file_path)
        mock_ocr.run_ocr = AsyncMock(side_effect=RuntimeError("Simulated pipeline stage failure"))

        mock_repo = MagicMock()
        mock_repo.fail_job = AsyncMock()

        mock_lifecycle = MagicMock()
        mock_lifecycle.notifier = MagicMock()
        mock_lifecycle.notifier.publish_progress = AsyncMock()
        mock_lifecycle.report_progress = AsyncMock()

        mock_checkpoint = MagicMock()
        mock_checkpoint.persist_stage_checkpoint = AsyncMock(return_value={})

        orchestrator = PipelineOrchestrator(
            job_repo=mock_repo,
            lifecycle_service=mock_lifecycle,
            checkpoint_service=mock_checkpoint,
            s3_client=mock_s3,
            ocr_handler=mock_ocr,
            layout_handler=MagicMock(),
            graph_handler=MagicMock(),
            clinical_handler=MagicMock(),
            analysis_handler=MagicMock(),
            summary_handler=MagicMock(),
            embedding_handler=MagicMock(),
        )

        job_payload = {
            "id": str(uuid.uuid4()),
            "file_key": "user-uploads/original.pdf",
            "metadata": {
                "patientId": str(uuid.uuid4()),
                "documentId": str(uuid.uuid4()),
                "mimeType": "application/pdf",
                "key": "user-uploads/original.pdf",
            },
            "checkpoint_data": {},
            "completed_stages": [],
            "percentage": 0,
        }

        # Run pipeline and expect the simulated failure
        with pytest.raises(RuntimeError, match="Simulated pipeline stage failure"):
            await orchestrator.process_job(job_payload)

        # 3. Assert: temp file WAS unlinked
        assert not temp_file_path.exists(), "Temporary file must be deleted in finally block"

        # 4. Assert: persistent original source file was NOT deleted
        assert persistent_source_path.exists(), "Persistent source file must never be unlinked"

        # 5. Assert: S3 delete APIs were NEVER called
        assert mock_s3.delete_object.call_count == 0, "S3 delete_object must never be called"
        assert mock_s3.delete_objects.call_count == 0, "S3 delete_objects must never be called"

    finally:
        if temp_file_path.exists():
            temp_file_path.unlink()
        if persistent_source_path.exists():
            persistent_source_path.unlink()
