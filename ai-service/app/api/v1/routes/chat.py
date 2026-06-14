from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse

from app.api.v1.schemas.chat import ChatRequest
from app.infrastructure.db.repositories.intelligence_repository import IntelligenceRepository
from app.infrastructure.db.repositories.medication_repository import MedicationRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/chat", tags=["chat"])


@router.post("")
async def chat(payload: ChatRequest, request: Request) -> dict:
    logger.info("chat_request_received", extra={
        "user_id": str(payload.user_id),
        "message_preview": payload.message[:100] if payload.message else None,
        "document_id": str(payload.document_id) if payload.document_id else None,
        "session_id": payload.session_id,
    })
    container = request.app.state.container
    async with container.db.session_factory() as session:
        try:
            response = await container.chat.answer(
                user_id=payload.user_id,
                message=payload.message,
                document_id=payload.document_id,
                session_id=payload.session_id,
                retrieved_chunks=payload.retrieved_chunks,
                history=payload.history,
                intelligence_repo=IntelligenceRepository(session),
                medication_repo=MedicationRepository(session),
            )
            await session.commit()

            logger.info("chat_response_sent", extra={
                "user_id": str(payload.user_id),
                "answer_length": len(response.get("answer", "")),
                "answer_preview": response.get("answer", "")[:100],
                "citations_count": len(response.get("citations", [])),
            })

            return {"success": True, "data": response}
        except Exception as e:
            logger.error("chat_request_failed", extra={
                "user_id": str(payload.user_id),
                "error": str(e),
                "error_type": type(e).__name__,
            })
            raise


@router.post("/stream")
async def stream_chat(payload: ChatRequest, request: Request) -> StreamingResponse:
    container = request.app.state.container

    async def event_stream():
        async with container.db.session_factory() as session:
            async for token in container.chat.stream_answer(
                user_id=payload.user_id,
                message=payload.message,
                document_id=payload.document_id,
                session_id=payload.session_id,
                retrieved_chunks=payload.retrieved_chunks,
                history=payload.history,
                intelligence_repo=IntelligenceRepository(session),
                medication_repo=MedicationRepository(session),
            ):
                yield f"data: {json.dumps({'token': token})}\n\n"
            await session.commit()
            yield "data: {\"done\": true}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@router.websocket("/ws")
async def chat_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    container = websocket.app.state.container
    try:
        while True:
            raw_text = await websocket.receive_text()
            try:
                payload = ChatRequest.model_validate_json(raw_text)
            except Exception as e:
                logger.warning("chat_ws_validation_error", extra={"error": str(e)})
                await websocket.send_json({"type": "error", "message": f"Invalid request payload: {e}"})
                continue

            try:
                async with container.db.session_factory() as session:
                    async for token in container.chat.stream_answer(
                        user_id=payload.user_id,
                        message=payload.message,
                        document_id=payload.document_id,
                        session_id=payload.session_id,
                        intelligence_repo=IntelligenceRepository(session),
                        medication_repo=MedicationRepository(session),
                    ):
                        await websocket.send_json({"type": "token", "token": token})
                    await session.commit()
                await websocket.send_json({"type": "done"})
            except Exception as e:
                logger.error("chat_ws_error", extra={"user_id": str(payload.user_id), "error": str(e)}, exc_info=True)
                await websocket.send_json({"type": "error", "message": f"Chat stream failed: {e}"})
    except WebSocketDisconnect:
        logger.info("chat_ws_disconnected")
    except Exception as e:
        logger.exception("chat_ws_unexpected_error")
