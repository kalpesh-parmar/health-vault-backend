from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI

from app.container import Container
from app.core.logging import configure_logging
from app.settings import get_settings


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    configure_logging(settings.log_level)
    container = Container(settings)
    await container.start()
    app.state.container = container
    try:
        yield
    finally:
        await container.stop()
