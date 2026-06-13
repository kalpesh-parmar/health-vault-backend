from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path

from google.cloud import storage
from google.oauth2 import service_account
from app.settings import Settings


class GcsStorageClient:
    def __init__(self, settings: Settings) -> None:
        credentials = None
        if settings.gcp_credentials_base64:
            info = json.loads(base64.b64decode(settings.gcp_credentials_base64).decode("utf-8"))
            credentials = service_account.Credentials.from_service_account_info(info)
        self.client = storage.Client(
            project=settings.gcp_project_id,
            credentials=credentials,
        )

    async def download(self, *, bucket: str, key: str, destination: Path) -> Path:
        destination.parent.mkdir(parents=True, exist_ok=True)
        blob = self.client.bucket(bucket).blob(key)
        await asyncio.to_thread(blob.download_to_filename, str(destination))
        return destination

    async def read_bytes(self, *, bucket: str, key: str) -> bytes:
        blob = self.client.bucket(bucket).blob(key)
        return await asyncio.to_thread(blob.download_as_bytes)
