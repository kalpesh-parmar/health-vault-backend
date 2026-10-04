from __future__ import annotations

import asyncio
import logging
from uuid import UUID

from app.infrastructure.db.repositories.job_repository import JobRepository
from app.infrastructure.db.session import Database

logger = logging.getLogger(__name__)


class JobHeartbeat:
    def __init__(
        self,
        db: Database,
        job_id: UUID,
        interval_seconds: float = 15.0,
    ) -> None:
        self.db = db
        self.job_id = job_id
        self.interval_seconds = interval_seconds
        self.repo = JobRepository(db)
        self._task: asyncio.Task | None = None
        self._running = False

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._heartbeat_loop())

    async def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _heartbeat_loop(self) -> None:
        while self._running:
            try:
                await asyncio.sleep(self.interval_seconds)
                if not self._running:
                    break
                updated = await self.repo.update_job_heartbeat(self.job_id)
                if not updated:
                    logger.info("Job %s is no longer RUNNING; stopping heartbeat loop.", self.job_id)
                    break
                logger.debug("Heartbeat updated for job %s", self.job_id)
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.warning("Failed to touch heartbeat for job %s: %s", self.job_id, e)
