from __future__ import annotations

import asyncio
from uuid import UUID

_dispatch_queue: asyncio.Queue[UUID] | None = None
_bound_loop: asyncio.AbstractEventLoop | None = None


def get_dispatch_queue() -> asyncio.Queue[UUID]:
    global _dispatch_queue, _bound_loop
    try:
        current_loop = asyncio.get_running_loop()
    except RuntimeError:
        current_loop = None

    if (
        _dispatch_queue is None
        or (_bound_loop is not None and current_loop is not None and _bound_loop is not current_loop)
    ):
        _dispatch_queue = asyncio.Queue()
        _bound_loop = current_loop

    return _dispatch_queue


def reset_dispatch_queue() -> None:
    global _dispatch_queue, _bound_loop
    _dispatch_queue = None
    _bound_loop = None
