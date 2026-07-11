from __future__ import annotations

import logging
from fastapi import APIRouter, Request, HTTPException, status
from pydantic import BaseModel

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/translate", tags=["translation"])


class TranslationRequest(BaseModel):
    text: str
    src_lang: str = "en"
    tgt_lang: str


@router.post("")
async def translate_text(payload: TranslationRequest, request: Request) -> dict:
    logger.info("translation_request_received", extra={
        "src_lang": payload.src_lang,
        "tgt_lang": payload.tgt_lang,
        "text_preview": payload.text[:100] if payload.text else None
    })
    
    container = request.app.state.container
    if not container.translation.is_warm:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Translation model is warming up or failed to load"
        )
        
    try:
        translated = await container.translation.translate(
            text=payload.text,
            src_lang=payload.src_lang,
            tgt_lang=payload.tgt_lang
        )
        return {
            "success": True,
            "translated_text": translated
        }
    except Exception as e:
        logger.error(f"[TranslationRoute] Error during translation: {e}", exc_info=True)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(e)
        )
