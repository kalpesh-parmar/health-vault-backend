from __future__ import annotations

import hmac
from fastapi import Depends, Header, HTTPException, status

from app.settings import Settings, get_settings


def verify_internal_key(
    x_internal_service_key: str | None = Header(default=None, alias="X-Internal-Service-Key"),
    settings: Settings = Depends(get_settings),
) -> str:
    if not x_internal_service_key:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing required X-Internal-Service-Key header",
        )

    expected_key = settings.internal_service_key.strip()
    provided_key = x_internal_service_key.strip()

    if not hmac.compare_digest(provided_key.encode("utf-8"), expected_key.encode("utf-8")):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid internal service key",
        )

    return provided_key
