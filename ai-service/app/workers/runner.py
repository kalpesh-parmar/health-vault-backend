from __future__ import annotations

import asyncio
import logging
from typing import Any, Callable, Coroutine
from uuid import UUID

from app.infrastructure.db.repositories.job_repository import JobRepository
from app.infrastructure.db.session import Database
from app.settings import Settings
from app.workers.claimer import JobClaimer
from app.workers.dispatch_queue import get_dispatch_queue
from app.workers.heartbeat import JobHeartbeat
from app.workers.reconciler import CrashReconciler

logger = logging.getLogger(__name__)


class WorkerRunner:
    def __init__(
        self,
        db: Database,
        settings: Settings,
        job_handler: Callable[[dict[str, Any]], Coroutine[Any, Any, None]] | None = None,
        dispatch_queue: asyncio.Queue[UUID] | None = None,
    ) -> None:
        self.db = db
        self.settings = settings
        self.repo = JobRepository(db)
        self.claimer = JobClaimer(db, settings)
        self.dispatch_queue = dispatch_queue if dispatch_queue is not None else get_dispatch_queue()
        self.reconciler = CrashReconciler(
            db,
            stale_seconds=settings.worker_heartbeat_stale_seconds,
            interval_seconds=settings.worker_reconciler_interval_seconds,
        )
        self.job_handler = job_handler
        self.active_tasks: dict[UUID, asyncio.Task] = {}
        self.stopping = False
        self._main_task: asyncio.Task | None = None

    async def start(self) -> None:
        logger.info("Starting worker runner (concurrency=%d)...", self.settings.worker_concurrency)
        self.stopping = False
        await self.reconciler.start()
        self._main_task = asyncio.create_task(self._run_loop())

    async def stop(self, drain_timeout: float = 10.0) -> None:
        logger.info("Stopping worker runner gracefully...")
        self.stopping = True
        await self.reconciler.stop()

        if self._main_task and not self._main_task.done():
            self._main_task.cancel()
            try:
                await self._main_task
            except asyncio.CancelledError:
                pass

        if self.active_tasks:
            logger.info("Waiting for %d active job tasks to drain...", len(self.active_tasks))
            try:
                await asyncio.wait_for(
                    asyncio.gather(*list(self.active_tasks.values()), return_exceptions=True),
                    timeout=drain_timeout,
                )
            except asyncio.TimeoutError:
                logger.warning(
                    "Active tasks did not finish within %fs; cancelling remaining tasks...", drain_timeout
                )
                for task in list(self.active_tasks.values()):
                    if not task.done():
                        task.cancel()
                await asyncio.gather(*list(self.active_tasks.values()), return_exceptions=True)
            self.active_tasks.clear()

        logger.info("Worker runner stopped cleanly.")

    async def _run_loop(self) -> None:
        while not self.stopping:
            try:
                job_id = None
                try:
                    # Wait for push dispatch or timeout to poll
                    job_id = await asyncio.wait_for(
                        self.dispatch_queue.get(),
                        timeout=self.settings.worker_poll_interval_seconds,
                    )
                except asyncio.TimeoutError:
                    pass

                if self.stopping:
                    break

                job = None
                if job_id:
                    job = await self.claimer.claim_job(job_id)
                
                # If no direct dispatch claimed, poll oldest queued job
                if not job and not self.stopping:
                    job = await self.claimer.claim_next()

                if job:
                    job_uuid = UUID(str(job["id"]))
                    try:
                        task = asyncio.create_task(self._process_claimed_job(job))
                        self.active_tasks[job_uuid] = task
                        task.add_done_callback(lambda t, j_id=job_uuid: self.active_tasks.pop(j_id, None))
                    except Exception:
                        self.claimer.release_slot()
                        raise

            except asyncio.CancelledError:
                break
            except Exception as e:
                logger.error("Error in worker runner loop: %s", e)
                await asyncio.sleep(1.0)

    async def _process_claimed_job(self, job: dict[str, Any]) -> None:
        job_id = UUID(str(job["id"]))
        heartbeat = JobHeartbeat(
            self.db,
            job_id,
            interval_seconds=self.settings.worker_heartbeat_interval_seconds,
        )
        await heartbeat.start()
        try:
            if self.job_handler:
                await self.job_handler(job)
            else:
                logger.info("Default no-op handler executed for job %s", job_id)
        except Exception as e:
            logger.exception("Job %s failed with error: %s", job_id, e)
            await self.repo.fail_job(job_id, error=str(e))
        finally:
            try:
                await heartbeat.stop()
            finally:
                self.claimer.release_slot()
