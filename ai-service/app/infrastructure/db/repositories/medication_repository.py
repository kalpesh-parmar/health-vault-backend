from __future__ import annotations

import uuid

from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession


class MedicationRepository:
    def __init__(self, session: AsyncSession) -> None:
        self.session = session

    async def active_medications(self, user_id: uuid.UUID) -> list[dict]:
        result = await self.session.execute(
            text("SELECT * FROM medications WHERE user_id = :user_id AND soft_delete = false"),
            {"user_id": str(user_id)},
        )
        return [dict(row._mapping) for row in result.fetchall()]

    async def reminders(self, user_id: uuid.UUID, limit: int = 20) -> list[dict]:
        result = await self.session.execute(
            text("SELECT * FROM notifications WHERE user_id = :user_id ORDER BY created_at DESC LIMIT :limit"),
            {"user_id": str(user_id), "limit": limit},
        )
        return [dict(row._mapping) for row in result.fetchall()]
