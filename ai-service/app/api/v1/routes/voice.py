from __future__ import annotations

import base64
import logging
import shutil
import tempfile
import uuid
from pathlib import Path

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.api.v1.schemas.chat import ChatRequest
from app.infrastructure.db.repositories.intelligence_repository import IntelligenceRepository
from app.infrastructure.db.repositories.medication_repository import MedicationRepository

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/voice", tags=["voice"])


@router.websocket("/ws")
async def voice_ws(websocket: WebSocket) -> None:
    await websocket.accept()
    container = websocket.app.state.container
    workspace = Path(tempfile.mkdtemp(prefix=f"voice-{uuid.uuid4()}-"))
    audio_path = workspace / "input.webm"
    try:
        while True:
            message = await websocket.receive()
            if "bytes" in message:
                try:
                    with audio_path.open("ab") as file:
                        file.write(message["bytes"])
                    await websocket.send_json({"type": "audio_received"})
                except Exception as e:
                    logger.error("voice_ws_audio_write_failed", extra={"error": str(e)})
                    await websocket.send_json({"type": "error", "message": f"Failed to write audio chunk: {e}"})
                continue

            if "text" not in message:
                continue

            try:
                data = ChatRequest.model_validate_json(message["text"])
            except Exception as e:
                logger.warning("voice_ws_validation_error", extra={"error": str(e)})
                await websocket.send_json({"type": "error", "message": f"Invalid request payload: {e}"})
                continue

            try:
                voice = await container.models.get_voice()
                transcript = await voice.transcribe_file(audio_path) if audio_path.exists() else data.message
                await websocket.send_json({"type": "transcript", "text": transcript})

                response_parts: list[str] = []
                async with container.db.session_factory() as session:
                    async for token in container.chat.stream_answer(
                        user_id=data.user_id,
                        message=transcript or data.message,
                        document_id=data.document_id,
                        session_id=data.session_id,
                        intelligence_repo=IntelligenceRepository(session),
                        medication_repo=MedicationRepository(session),
                    ):
                        response_parts.append(token)
                        await websocket.send_json({"type": "token", "token": token})
                    await session.commit()

                # Clean up input audio so subsequent messages start fresh
                if audio_path.exists():
                    audio_path.unlink()

                speech_path = workspace / "response.wav"
                await voice.synthesize_to_file("".join(response_parts), speech_path)
                await websocket.send_json(
                    {
                        "type": "audio",
                        "mimeType": "audio/wav",
                        "data": base64.b64encode(speech_path.read_bytes()).decode("ascii"),
                    }
                )
                await websocket.send_json({"type": "done"})
            except Exception as e:
                logger.error("voice_ws_processing_error", extra={"user_id": str(data.user_id), "error": str(e)}, exc_info=True)
                await websocket.send_json({"type": "error", "message": f"Voice processing failed: {e}"})

    except WebSocketDisconnect:
        logger.info("voice_ws_disconnected")
    except Exception as e:
        logger.exception("voice_ws_unexpected_error")
    finally:
        shutil.rmtree(workspace, ignore_errors=True)
