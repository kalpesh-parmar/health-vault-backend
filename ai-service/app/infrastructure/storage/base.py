from __future__ import annotations

from pathlib import Path
from typing import Protocol


class StorageClient(Protocol):
    async def download(self, *, bucket: str, key: str, destination: Path) -> Path:
        ...

    async def read_bytes(self, *, bucket: str, key: str) -> bytes:
        ...
