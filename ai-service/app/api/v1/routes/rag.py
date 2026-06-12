from __future__ import annotations

from fastapi import APIRouter, Request

from app.api.v1.schemas.chat import ChatRequest
from app.infrastructure.db.repositories.intelligence_repository import IntelligenceRepository
from app.infrastructure.db.repositories.medication_repository import MedicationRepository

router = APIRouter(prefix="/rag", tags=["rag"])


@router.post("/retrieve")
async def retrieve(payload: ChatRequest, request: Request) -> dict:
    container = request.app.state.container
    async with container.db.session_factory() as session:
        context = await container.rag.retrieve(
            user_id=payload.user_id,
            message=payload.message,
            document_id=payload.document_id,
            session_id=payload.session_id,
            intelligence_repo=IntelligenceRepository(session),
            medication_repo=MedicationRepository(session),
        )
        return {"success": True, "data": context}
