from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.container import Container
from app.core.logging import configure_logging
from app.settings import Settings, get_settings


def detect_uvicorn_worker_count() -> int:
    for env_var in ("WEB_CONCURRENCY", "UVICORN_WORKERS"):
        val = os.environ.get(env_var)
        if val and val.strip().isdigit():
            return int(val.strip())

    for i, arg in enumerate(sys.argv):
        if arg == "--workers" and i + 1 < len(sys.argv) and sys.argv[i + 1].isdigit():
            return int(sys.argv[i + 1])
        if arg.startswith("--workers="):
            val = arg.split("=", 1)[1]
            if val.isdigit():
                return int(val)

    return 1


def validate_worker_mode_configuration(settings: Settings, worker_count: int | None = None) -> None:
    if worker_count is None:
        worker_count = detect_uvicorn_worker_count()

    mode = (settings.worker_mode or "standalone").strip().lower()
    if mode == "in_process" and worker_count > 1:
        raise RuntimeError(
            f"Invalid configuration: WORKER_MODE='in_process' is prohibited with multi-worker Uvicorn (detected {worker_count} workers). "
            "Running in-process workers with multiple server processes creates duplicate worker loops and uncoordinated state transitions. "
            "Use the default WORKER_MODE='standalone' with a dedicated worker process, or run Uvicorn with a single worker."
        )


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    validate_worker_mode_configuration(settings)
    configure_logging(settings.log_level)
    container = Container(settings)
    await container.start()
    app.state.container = container

    worker_runner = None
    mode = (settings.worker_mode or "standalone").strip().lower()
    if mode == "in_process":
        from app.workers.runner import WorkerRunner

        worker_runner = WorkerRunner(
            container.db,
            settings,
            job_handler=container.pipeline_orchestrator.process_job,
        )
        await worker_runner.start()
        app.state.worker_runner = worker_runner

    try:
        yield
    finally:
        if worker_runner is not None:
            await worker_runner.stop()
        await container.stop()

