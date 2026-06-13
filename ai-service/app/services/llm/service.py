from __future__ import annotations

import json
import logging
import time
from collections.abc import AsyncIterator

from app.core.errors import ModelUnavailableError
from app.services.ai_client import AiClient, AiClientConfig, build_ai_client
from app.services.llm.utils import clean_messages
from app.settings import Settings

logger = logging.getLogger(__name__)


class LLMModelError(ModelUnavailableError):
    """Raised when the single configured model cannot complete a request."""


class LLMService:
    def __init__(
        self,
        *,
        api_key: str | None,
        base_url: str,
        model: str,
        timeout_seconds: float,
        max_retries: int,
        max_output_tokens: int,
    ) -> None:
        if not base_url:
            raise ValueError("AI_BASE_URL is required")
        if not model:
            raise ValueError("AI_MODEL is required")

        self.model = model.strip()
        self._client: AiClient = build_ai_client(
            AiClientConfig(
                api_key=api_key or "",
                base_url=base_url,
                model=self.model,
                timeout_seconds=float(timeout_seconds),
                max_retries=int(max_retries),
                max_output_tokens=int(max_output_tokens),
            )
        )

    async def chat(
        self,
        *,
        model: str | None = None,
        messages: list[dict],
        temperature: float = 0.2,
        format_json: bool = False,
        num_predict: int | None = None,
    ) -> str:
        del model
        started = time.monotonic()
        try:
            text, _finish_reason = await self._client.generate_text(
                messages=clean_messages(messages),
                temperature=temperature,
                format_json=format_json,
                max_tokens=num_predict,
            )
        except Exception as exc:
            logger.error("llm_model_failed", extra={"engine": self._client.engine, "model": self.model, "error": str(exc)})
            raise LLMModelError(f"Configured AI model failed: {exc}") from exc

        if not text.strip():
            raise LLMModelError("Configured AI model returned an empty response")
        if format_json:
            _validate_json(text)

        logger.info(
            "llm_chat_ok",
            extra={
                "engine": self._client.engine,
                "model": self.model,
                "elapsed_ms": int((time.monotonic() - started) * 1000),
                "fallback_used": False,
            },
        )
        return text

    async def stream_chat(
        self,
        *,
        model: str | None = None,
        messages: list[dict],
        temperature: float = 0.2,
        num_predict: int | None = None,
    ) -> AsyncIterator[str]:
        yield await self.chat(
            model=model,
            messages=messages,
            temperature=temperature,
            num_predict=num_predict,
        )

    async def health(self) -> dict:
        return {
            "ok": True,
            "engine": self._client.engine,
            "model": self.model,
            "fallback": None,
        }

    async def close(self) -> None:
        await self._client.close()


def build_llm_service(settings: Settings) -> LLMService:
    return LLMService(
        api_key=settings.ai_api_key or "",
        base_url=settings.ai_base_url,
        model=settings.ai_model,
        timeout_seconds=settings.ai_timeout_seconds,
        max_retries=settings.ai_max_retries,
        max_output_tokens=settings.ai_max_output_tokens,
    )


def _validate_json(text: str) -> None:
    candidate = (text or "").replace("```json", "").replace("```", "").strip()
    try:
        json.loads(candidate)
    except json.JSONDecodeError as exc:
        raise LLMModelError("Configured AI model returned invalid JSON") from exc
