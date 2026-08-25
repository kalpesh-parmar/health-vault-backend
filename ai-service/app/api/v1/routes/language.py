import logging
from fastapi import APIRouter, Request, HTTPException, status
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/language", tags=["language"])

class DetectLanguageRequest(BaseModel):
    text: str

@router.post("/detect")
async def detect_language(payload: DetectLanguageRequest, request: Request) -> dict:
    container = request.app.state.container
    if not container.language_detection.is_warm:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Language detection model is warming up or failed to load"
        )
        
    try:
        detected_language = await container.language_detection.detect_language(
            text=payload.text
        )
        return {
            "success": True,
            "language": detected_language
        }
    except Exception as e:
        logger.error(f"[LanguageRoute] Error during language detection: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
