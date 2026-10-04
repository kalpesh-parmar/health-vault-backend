from __future__ import annotations

import asyncio
import logging
import signal
import sys

from app.core.logging import configure_logging
from app.infrastructure.db.session import Database
from app.settings import get_settings
from app.workers.runner import WorkerRunner

logger = logging.getLogger("app.workers.worker")


async def main() -> None:
    settings = get_settings()
    configure_logging(settings.log_level)

    logger.info("Initializing Health Vault Standalone AI Worker daemon...")
    from app.container import Container

    container = Container(settings)
    runner = WorkerRunner(
        container.db,
        settings,
        job_handler=container.pipeline_orchestrator.process_job,
    )

    stop_event = asyncio.Event()

    def _handle_signal(*_: object) -> None:
        logger.info("Received termination signal. Requesting worker stop...")
        stop_event.set()

    # Register OS signals where available (SIGTERM/SIGINT)
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            loop.add_signal_handler(sig, _handle_signal)
        except NotImplementedError:
            # Signal handlers on Windows may not support add_signal_handler for all signals
            signal.signal(sig, _handle_signal)

    await runner.start()

    try:
        await stop_event.wait()
    finally:
        await runner.stop()
        await container.stop()
        logger.info("Worker process terminated.")


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (KeyboardInterrupt, SystemExit):
        sys.exit(0)
