from __future__ import annotations

import asyncio
import hashlib
import json
import tempfile
import uuid
from collections.abc import AsyncIterator
from pathlib import Path
from typing import Any

import boto3

from app.settings import Settings


class CorruptFileException(Exception):
    """Raised when file integrity check fails or file content is invalid/corrupt."""
    pass


class S3StorageClient:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        kwargs = {"region_name": settings.aws_region}
        if settings.aws_access_key_id and settings.aws_secret_access_key:
            kwargs["aws_access_key_id"] = settings.aws_access_key_id
            kwargs["aws_secret_access_key"] = settings.aws_secret_access_key
        self.client = boto3.client("s3", **kwargs)

    async def download(self, *, bucket: str, key: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(self.client.download_file, bucket, key, str(destination))
        return destination

    async def read_bytes(self, *, bucket: str, key: str) -> bytes:
        def load() -> bytes:
            response = self.client.get_object(Bucket=bucket, Key=key)
            return response["Body"].read()

        return await asyncio.to_thread(load)

    async def stream_file_bytes(
        self, bucket: str, key: str, chunk_size: int = 64 * 1024
    ) -> AsyncIterator[bytes]:
        response = await asyncio.to_thread(self.client.get_object, Bucket=bucket, Key=key)
        body = response["Body"]
        try:
            while True:
                chunk = await asyncio.to_thread(body.read, chunk_size)
                if not chunk:
                    break
                yield chunk
        finally:
            body.close()

    async def download_to_temp_file(
        self,
        bucket: str,
        key: str,
        expected_sha256: str | None = None,
        temp_dir: Path | None = None,
    ) -> Path:
        if temp_dir is None:
            temp_dir = Path(tempfile.gettempdir()) / "health_vault_docs"
        temp_dir.mkdir(parents=True, exist_ok=True)

        suffix = Path(key).suffix or ".bin"
        temp_file = temp_dir / f"{uuid.uuid4()}{suffix}"

        hasher = hashlib.sha256()

        def _do_download_and_hash() -> None:
            response = self.client.get_object(Bucket=bucket, Key=key)
            body = response["Body"]
            try:
                with open(temp_file, "wb") as f:
                    while True:
                        chunk = body.read(64 * 1024)
                        if not chunk:
                            break
                        f.write(chunk)
                        hasher.update(chunk)
            finally:
                body.close()

        await asyncio.to_thread(_do_download_and_hash)

        if expected_sha256:
            computed_sha = hasher.hexdigest().lower()
            if computed_sha != expected_sha256.strip().lower():
                # Remove corrupt file
                if temp_file.exists():
                    temp_file.unlink()
                raise CorruptFileException(
                    f"File integrity check failed for s3://{bucket}/{key}: "
                    f"expected sha256={expected_sha256}, computed={computed_sha}"
                )

        return temp_file

    async def upload_json_artifact(
        self, bucket: str, key: str, data: dict[str, Any]
    ) -> str:
        raw_bytes = json.dumps(data, indent=2, ensure_ascii=False).encode("utf-8")

        def _put() -> None:
            self.client.put_object(
                Bucket=bucket,
                Key=key,
                Body=raw_bytes,
                ContentType="application/json",
            )

        await asyncio.to_thread(_put)
        return key

    async def upload_file(
        self, bucket: str, key: str, file_path: Path, content_type: str = "application/octet-stream"
    ) -> str:
        def _upload() -> None:
            extra_args = {"ContentType": content_type}
            self.client.upload_file(str(file_path), bucket, key, ExtraArgs=extra_args)

        await asyncio.to_thread(_upload)
        return key

    async def upload_bytes(
        self, bucket: str, key: str, data: bytes, content_type: str = "image/png"
    ) -> str:
        def _put() -> None:
            self.client.put_object(
                Bucket=bucket,
                Key=key,
                Body=data,
                ContentType=content_type,
            )

        await asyncio.to_thread(_put)
        return key
