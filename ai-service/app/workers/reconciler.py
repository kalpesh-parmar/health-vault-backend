from __future__ import annotations

import asyncio
import logging
from uuid import UUID

from app.infrastructure.db.repositories.job_repository import JobRepository, ReconcileResult
from app.infrastructure.db.session import Database

logger = logging.getLogger(__name__)


class CrashReconciler:
    def __init__(
        self,
        db: Database,
        stale_seconds: float = 180.0,
        max_attempts: int = 3,
        interval_seconds: float = 180.0,
    ) -> None:
        self.db = db
        self.stale_seconds = stale_seconds
        self.max_attempts = max_attempts
        self.interval_seconds = interval_seconds
        self.repo = JobRepository(db)
        self._task: asyncio.Task | None = None
        self._running = False

    async def reconcile_once(self) -> ReconcileResult:
        result = await self.repo.reconcile_stale_jobs(
            stale_seconds=self.stale_seconds,
            max_attempts=self.max_attempts,
        )
        if result.requeued:
            logger.warning(
                "Crash reconciler requeued %d stale jobs to QUEUED: %s",
                len(result.requeued),
                result.requeued,
            )
        if result.failed_unuploaded:
            logger.warning(
                "Crash reconciler marked %d unuploaded stale jobs as FAILED (requiresReupload=true): %s",
                len(result.failed_unuploaded),
                result.failed_unuploaded,
            )
        if result.failed_exceeded:
            logger.error(
                "Crash reconciler permanently failed %d exceeded jobs: %s",
                len(result.failed_exceeded),
                result.failed_exceeded,
            )
        return result

    async def start(self) -> None:
        if self._running:
            return
        self._running = True
        self._task = asyncio.create_task(self._reconcile_loop())

    async def stop(self) -> None:
        self._running = False
        if self._task and not self._task.done():
            self._task.cancel()
            try:
                await self._task
            except asyncio.CancelledError:
                pass
        self._task = None

    async def _reconcile_loop(self) -> None:
        # Initial boot recovery sweep to recover orphaned jobs immediately
        try:
            await self.reconcile_once()
        except asyncio.CancelledError:
            return
        except Exception as e:
            logger.error("Initial crash reconciler sweep error: %s", e)

        while self._running:
            try:
                await asyncio.sleep(self.interval_seconds)
                if not self._running:
                    break
                await self.reconcile_once()
            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Crash reconciler error: %s", e)
