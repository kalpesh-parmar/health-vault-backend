from __future__ import annotations

import hashlib
import io
import json
import tempfile
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from app.infrastructure.storage.s3 import CorruptFileException, S3StorageClient
from app.settings import Settings


@pytest.fixture
def mock_settings():
    return Settings(
        database_url="postgresql+asyncpg://postgres:postgres@localhost:5432/health_vault_test",
        ai_model="test-model",
        ai_base_url="http://localhost:11434",
        internal_service_key="secret-key-123",
        patient_documents_bucket="test-bucket",
        aws_region="us-east-1",
        aws_access_key_id="mock-key",
        aws_secret_access_key="mock-secret",
    )


@pytest.mark.asyncio
async def test_stream_file_bytes_reads_correct_content(mock_settings):
    client = S3StorageClient(mock_settings)
    sample_content = b"PDF document header and clinical content" * 50

    mock_body = io.BytesIO(sample_content)
    client.client.get_object = MagicMock(return_value={"Body": mock_body})

    collected = bytearray()
    async for chunk in client.stream_file_bytes("test-bucket", "test/doc.pdf", chunk_size=64):
        collected.extend(chunk)

    assert bytes(collected) == sample_content
    client.client.get_object.assert_called_once_with(Bucket="test-bucket", Key="test/doc.pdf")


@pytest.mark.asyncio
async def test_download_validates_sha256_integrity(mock_settings):
    client = S3StorageClient(mock_settings)
    sample_content = b"Authentic prescription PDF data"
    correct_sha256 = hashlib.sha256(sample_content).hexdigest()

    mock_body = io.BytesIO(sample_content)
    client.client.get_object = MagicMock(return_value={"Body": mock_body})

    with tempfile.TemporaryDirectory() as tmp_dir:
        temp_path = await client.download_to_temp_file(
            bucket="test-bucket",
            key="prescriptions/rx1.pdf",
            expected_sha256=correct_sha256,
            temp_dir=Path(tmp_dir),
        )

        assert temp_path.exists()
        assert temp_path.read_bytes() == sample_content


@pytest.mark.asyncio
async def test_sha256_mismatch_raises_corrupt_file_exception(mock_settings):
    client = S3StorageClient(mock_settings)
    sample_content = b"Tampered or corrupted document bytes"
    wrong_sha256 = "0000000000000000000000000000000000000000000000000000000000000000"

    mock_body = io.BytesIO(sample_content)
    client.client.get_object = MagicMock(return_value={"Body": mock_body})

    with tempfile.TemporaryDirectory() as tmp_dir:
        with pytest.raises(CorruptFileException) as exc_info:
            await client.download_to_temp_file(
                bucket="test-bucket",
                key="prescriptions/corrupt.pdf",
                expected_sha256=wrong_sha256,
                temp_dir=Path(tmp_dir),
            )

        assert "File integrity check failed" in str(exc_info.value)


@pytest.mark.asyncio
async def test_upload_json_artifact_stores_s3_key(mock_settings):
    client = S3StorageClient(mock_settings)
    client.client.put_object = MagicMock()

    payload = {"patientId": "123", "extractedLabMetrics": [{"test": "Hemoglobin", "value": 14.2}]}
    key = "artifacts/patient_123/lab.json"

    saved_key = await client.upload_json_artifact("test-bucket", key, payload)
    assert saved_key == key

    client.client.put_object.assert_called_once()
    call_kwargs = client.client.put_object.call_args[1]
    assert call_kwargs["Bucket"] == "test-bucket"
    assert call_kwargs["Key"] == key
    assert call_kwargs["ContentType"] == "application/json"
    uploaded_data = json.loads(call_kwargs["Body"].decode("utf-8"))
    assert uploaded_data["extractedLabMetrics"][0]["value"] == 14.2
