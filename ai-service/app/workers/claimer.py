from __future__ import annotations

import asyncio
import logging
from typing import Any
from uuid import UUID

from app.infrastructure.db.repositories.job_repository import JobRepository
from app.infrastructure.db.session import Database
from app.settings import Settings

logger = logging.getLogger(__name__)


class JobClaimer:
    def __init__(self, db: Database, settings: Settings) -> None:
        self.db = db
        self.settings = settings
        self.repo = JobRepository(db)
        self.max_concurrency = settings.worker_concurrency
        self.semaphore = asyncio.BoundedSemaphore(settings.worker_concurrency)

    async def claim_next(self) -> dict[str, Any] | None:
        if self.semaphore.locked():
            return None

        await self.semaphore.acquire()
        try:
            job = await self.repo.claim_next_job()
            if not job:
                self.release_slot()
                return None
            return job
        except Exception:
            self.release_slot()
            raise

    async def claim_job(self, job_id: UUID) -> dict[str, Any] | None:
        if self.semaphore.locked():
            return None

        await self.semaphore.acquire()
        try:
            job = await self.repo.claim_specific_job(job_id)
            if not job:
                self.release_slot()
                return None
            return job
        except Exception:
            self.release_slot()
            raise

    def release_slot(self) -> None:
        try:
            self.semaphore.release()
        except ValueError:
            logger.warning("Attempted to release unacquired semaphore slot in JobClaimer")
