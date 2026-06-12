from __future__ import annotations

import asyncio
from pathlib import Path

import boto3
from app.settings import Settings


class S3StorageClient:
    def __init__(self, settings: Settings) -> None:
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
