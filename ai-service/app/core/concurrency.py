from __future__ import annotations

import asyncio
from dataclasses import dataclass


@dataclass(frozen=True)
class InferenceSemaphores:
    ocr: asyncio.Semaphore
    vision: asyncio.Semaphore
    chat: asyncio.Semaphore
    voice: asyncio.Semaphore

