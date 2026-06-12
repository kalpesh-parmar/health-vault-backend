from __future__ import annotations

import asyncio
import base64
import hashlib
import logging
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class AiClientConfig:
    api_key: str
    base_url: str
    model: str
    timeout_seconds: float
    max_retries: int
    max_output_tokens: int


class AiClient:
    engine = "ai-client"

    async def generate_text(
        self,
        *,
        messages: list[dict],
        temperature: float = 0.2,
        format_json: bool = False,
        max_tokens: int | None = None,
    ) -> tuple[str, str | None]:
        raise NotImplementedError

    async def generate_json_from_bytes(
        self,
        *,
        data: bytes,
        mime_type: str,
        prompt: str,
        temperature: float = 0,
    ) -> tuple[str, str | None]:
        raise NotImplementedError

    async def close(self) -> None:
        return None

    async def validate_model_available(self) -> None:
        return None

    def status(self) -> dict[str, Any]:
        return {"engine": self.engine}


class AiClientHttpError(RuntimeError):
    def __init__(
        self,
        message: str,
        *,
        status_code: int | None = None,
        response_body: str | None = None,
        request_body: dict[str, Any] | None = None,
        url: str | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_body = response_body
        self.request_body = request_body
        self.url = url


class GoogleGenAiClient(AiClient):
    engine = "google-genai"

    def __init__(self, config: AiClientConfig) -> None:
        self.config = config
        self._client = None

    def _ensure_client(self):
        if self._client is None:
            from google import genai
            from google.genai import types

            self._client = genai.Client(
                api_key=self.config.api_key,
                http_options=types.HttpOptions(timeout=int(self.config.timeout_seconds * 1000)),
            )
        return self._client

    async def generate_text(
        self,
        *,
        messages: list[dict],
        temperature: float = 0.2,
        format_json: bool = False,
        max_tokens: int | None = None,
    ) -> tuple[str, str | None]:
        from google.genai import types

        config_kwargs = {
            "temperature": temperature,
            "max_output_tokens": max_tokens or self.config.max_output_tokens,
        }
        if format_json:
            config_kwargs["response_mime_type"] = "application/json"

        response = await _with_retry(
            lambda: self._ensure_client().aio.models.generate_content(
                model=self.config.model,
                contents=_messages_to_prompt(messages),
                config=types.GenerateContentConfig(**config_kwargs),
            ),
            self.config.max_retries,
        )
        return getattr(response, "text", None) or "", _finish_reason(response)

    async def generate_json_from_bytes(
        self,
        *,
        data: bytes,
        mime_type: str,
        prompt: str,
        temperature: float = 0,
    ) -> tuple[str, str | None]:
        from google.genai import types

        config = types.GenerateContentConfig(
            temperature=temperature,
            response_mime_type="application/json",
            max_output_tokens=self.config.max_output_tokens,
            thinking_config=types.ThinkingConfig(thinking_budget=0),
        )
        response = await _with_retry(
            lambda: self._ensure_client().aio.models.generate_content(
                model=self.config.model,
                contents=[types.Part.from_bytes(data=data, mime_type=mime_type), prompt],
                config=config,
            ),
            self.config.max_retries,
        )
        return getattr(response, "text", None) or "", _finish_reason(response)


class ChatCompletionsClient(AiClient):
    engine = "chat-completions"

    def __init__(self, config: AiClientConfig) -> None:
        self.config = config
        self.base_url = config.base_url.rstrip("/")
        self._client: httpx.AsyncClient | None = None
        self._failure_count = 0
        self._circuit_open_until = 0.0

    def _ensure_http_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.config.timeout_seconds, trust_env=False)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    def _record_success(self) -> None:
        self._failure_count = 0
        self._circuit_open_until = 0.0

    def _record_failure(self) -> None:
        import time

        self._failure_count += 1
        if self._failure_count >= 3:
            self._circuit_open_until = time.monotonic() + 30.0

    async def generate_text(
        self,
        *,
        messages: list[dict],
        temperature: float = 0.2,
        format_json: bool = False,
        max_tokens: int | None = None,
    ) -> tuple[str, str | None]:
        prepared_messages = messages
        payload: dict[str, Any] = {
            "model": self.config.model,
            "messages": prepared_messages,
            "temperature": temperature,
            "max_tokens": max_tokens or self.config.max_output_tokens,
        }
        if format_json:
            payload["response_format"] = {"type": "json_object"}

        try:
            response = await self._post_chat(payload)
        except AiClientHttpError as exc:
            if not (format_json and _should_retry_without_response_format(exc)):
                raise
            fallback_messages = _append_json_instruction(prepared_messages)
            fallback_payload = {
                "model": self.config.model,
                "messages": fallback_messages,
                "temperature": temperature,
                "max_tokens": max_tokens or self.config.max_output_tokens,
            }
            logger.warning(
                "ai_http_retry_without_response_format",
                extra={
                    "engine": self.engine,
                    "status_code": exc.status_code,
                    "reason": _classify_http_error(exc.status_code or 0, exc.response_body or ""),
                },
            )
            response = await self._post_chat(fallback_payload)

        text, finish_reason = _chat_completion_text_and_finish(response)

        # Ollama may answer the first request after a cold model load with an
        # empty assistant message and done_reason/finish_reason="load". That is
        # not a valid model answer, but it is usually recoverable immediately
        # after the model finishes loading. Retry the exact same request before
        # letting upper layers decide how to degrade gracefully.
        if not text.strip() and _is_ollama_load_response(response, finish_reason):
            for attempt in range(max(1, self.config.max_retries)):
                await asyncio.sleep(0.5 * (attempt + 1))
                logger.warning(
                    "ai_http_empty_load_retry",
                    extra={
                        "engine": self.engine,
                        "model": self.config.model,
                        "attempt": attempt + 1,
                        "finish_reason": finish_reason,
                    },
                )
                response = await self._post_chat(payload)
                text, finish_reason = _chat_completion_text_and_finish(response)
                if text.strip() or not _is_ollama_load_response(response, finish_reason):
                    break

        return text, finish_reason

    async def generate_json_from_bytes(
        self,
        *,
        data: bytes,
        mime_type: str,
        prompt: str,
        temperature: float = 0,
    ) -> tuple[str, str | None]:
        """Extract structured JSON/text from image bytes.

        Text generation intentionally remains on the OpenAI-compatible
        /chat/completions flow. Image/OCR extraction for Ollama vision models
        must use Ollama's native /api/chat payload shape, where the base64
        image is passed in messages[].images instead of OpenAI's image_url
        content parts.
        """
        if mime_type == "application/pdf":
            raise AiClientHttpError(
                "Ollama/OpenAI-compatible vision does not accept raw PDF bytes. Render PDF pages to images before calling the vision model.",
                status_code=400,
            )

        payload = {
            "model": self.config.model,
            "messages": [
                _image_chat_content(data=data, mime_type=mime_type, prompt=_json_only_prompt(prompt))
            ],
            "stream": False,
            "options": {
                "temperature": temperature,
                "num_predict": self.config.max_output_tokens,
            },
        }

        response = await self._post_ollama_vision_chat(
            payload=payload,
            mime_type=mime_type,
            image_size=len(data),
        )
        content = _ollama_response_text(response)
        finish_reason = _ollama_finish_reason(response)

        if not content.strip() and _is_ollama_load_response(response, finish_reason):
            for attempt in range(max(1, self.config.max_retries)):
                await asyncio.sleep(0.5 * (attempt + 1))
                logger.warning(
                    "ollama_vision_empty_load_retry",
                    extra={
                        "engine": self.engine,
                        "model": self.config.model,
                        "attempt": attempt + 1,
                        "finish_reason": finish_reason,
                    },
                )
                response = await self._post_ollama_vision_chat(
                    payload=payload,
                    mime_type=mime_type,
                    image_size=len(data),
                )
                content = _ollama_response_text(response)
                finish_reason = _ollama_finish_reason(response)
                if content.strip() or not _is_ollama_load_response(response, finish_reason):
                    break

        logger.info(
            "ollama_vision_finish",
            extra={
                "engine": self.engine,
                "model": self.config.model,
                "finish_reason": finish_reason,
                "content_chars": len(content or ""),
            },
        )
        return content or "", finish_reason

    async def _post_ollama_vision_chat(
        self,
        *,
        payload: dict[str, Any],
        mime_type: str,
        image_size: int,
    ) -> dict[str, Any]:
        async def request() -> dict[str, Any]:
            import time

            if self._circuit_open_until:
                remaining = self._circuit_open_until - time.monotonic()
                if remaining > 0:
                    raise AiClientHttpError(
                        f"AI circuit breaker is open for {remaining:.1f}s after repeated failures",
                        status_code=503,
                    )

            _validate_ollama_vision_payload(payload)
            client = self._ensure_http_client()
            url = f"{_ollama_base_url(self.base_url)}/api/chat"
            safe_payload = _sanitize_payload(payload)
            logger.info(
                "ollama_vision_request",
                extra={
                    "engine": self.engine,
                    "model": self.config.model,
                    "url": url,
                    "endpoint": "/api/chat",
                    "mime_type": mime_type,
                    "image_size_bytes": image_size,
                    "payload_structure": _ollama_vision_payload_structure(payload),
                    "body": safe_payload,
                },
            )
            request_started = time.monotonic()
            try:
                response = await client.post(url, json=payload)
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                self._record_failure()
                logger.error(
                    "ollama_vision_transport_error",
                    extra={
                        "engine": self.engine,
                        "model": self.config.model,
                        "url": url,
                        "endpoint": "/api/chat",
                        "mime_type": mime_type,
                        "image_size_bytes": image_size,
                        "error": str(exc),
                        "classification": _classify_transport_error(exc),
                        "elapsed_ms": int((time.monotonic() - request_started) * 1000),
                        "request_body": safe_payload,
                    },
                )
                raise

            elapsed_ms = int((time.monotonic() - request_started) * 1000)
            if response.status_code >= 400:
                self._record_failure()
                logger.error(
                    "ollama_vision_http_error",
                    extra={
                        "engine": self.engine,
                        "model": self.config.model,
                        "url": url,
                        "endpoint": "/api/chat",
                        "mime_type": mime_type,
                        "image_size_bytes": image_size,
                        "status_code": response.status_code,
                        "response_body": response.text,
                        "request_body": safe_payload,
                        "classification": _classify_http_error(response.status_code, response.text),
                        "elapsed_ms": elapsed_ms,
                    },
                )
                raise AiClientHttpError(
                    f"Ollama vision request failed with HTTP {response.status_code}: {response.text[:500]}",
                    status_code=response.status_code,
                    response_body=response.text,
                    request_body=safe_payload,
                    url=url,
                )

            self._record_success()
            parsed = response.json()
            logger.info(
                "ollama_vision_response",
                extra={
                    "engine": self.engine,
                    "model": self.config.model,
                    "url": url,
                    "endpoint": "/api/chat",
                    "status_code": response.status_code,
                    "elapsed_ms": elapsed_ms,
                    "response_bytes": len(response.content or b""),
                    "finish_reason": parsed.get("done_reason"),
                    "raw_response": _sanitize_payload(parsed),
                },
            )
            return parsed

        return await _with_retry(request, self.config.max_retries)

    async def _post_chat(self, payload: dict[str, Any]) -> dict[str, Any]:
        async def request() -> dict[str, Any]:
            import time

            if self._circuit_open_until:
                remaining = self._circuit_open_until - time.monotonic()
                if remaining > 0:
                    raise AiClientHttpError(
                        f"AI circuit breaker is open for {remaining:.1f}s after repeated failures",
                        status_code=503,
                    )
            _validate_chat_completions_payload(payload)
            client = self._ensure_http_client()
            headers = {}
            if self.config.api_key:
                headers["Authorization"] = f"Bearer {self.config.api_key}"
            url = _chat_completions_url(self.base_url)
            safe_payload = _sanitize_payload(payload)
            safe_headers = _sanitize_headers(headers)
            logger.info(
                "ai_http_request",
                extra={"engine": self.engine, "url": url, "headers": safe_headers, "body": safe_payload},
            )
            request_started = time.monotonic()
            try:
                response = await client.post(
                    url,
                    json=payload,
                    headers=headers,
                )
            except (httpx.TimeoutException, httpx.TransportError) as exc:
                self._record_failure()
                logger.error(
                    "ai_http_transport_error",
                    extra={
                        "engine": self.engine,
                        "url": url,
                        "error": str(exc),
                        "classification": _classify_transport_error(exc),
                        "elapsed_ms": int((time.monotonic() - request_started) * 1000),
                        "request_headers": safe_headers,
                        "request_body": safe_payload,
                    },
                )
                raise
            elapsed_ms = int((time.monotonic() - request_started) * 1000)
            if response.status_code >= 400:
                self._record_failure()
                logger.error(
                    "ai_http_error",
                    extra={
                        "engine": self.engine,
                        "url": url,
                        "status_code": response.status_code,
                        "response_body": response.text,
                        "request_headers": safe_headers,
                        "request_body": safe_payload,
                        "classification": _classify_http_error(response.status_code, response.text),
                        "elapsed_ms": elapsed_ms,
                    },
                )
                raise AiClientHttpError(
                    f"AI chat-completions request failed with HTTP {response.status_code}: {response.text[:500]}",
                    status_code=response.status_code,
                    response_body=response.text,
                    request_body=safe_payload,
                    url=url,
                )
            self._record_success()
            parsed = response.json()
            logger.info(
                "ai_http_response",
                extra={
                    "engine": self.engine,
                    "url": url,
                    "status_code": response.status_code,
                    "elapsed_ms": elapsed_ms,
                    "response_bytes": len(response.content or b""),
                    "usage": _usage_summary(parsed),
                },
            )
            return parsed

        return await _with_retry(request, self.config.max_retries)

    async def validate_model_available(self) -> None:
        if _looks_like_ollama_native_base_url(self.base_url):
            url = f"{_ollama_base_url(self.base_url)}/api/tags"
            try:
                response = await self._ensure_http_client().get(url)
            except Exception as exc:
                raise AiClientHttpError(f"AI model validation could not reach {url}: {exc}", url=url) from exc
            if response.status_code >= 400:
                raise AiClientHttpError(
                    f"AI model validation failed with HTTP {response.status_code}",
                    status_code=response.status_code,
                    response_body=response.text,
                    url=url,
                )
            data = response.json()
            models = {item.get("name") or item.get("model") for item in data.get("models", []) if isinstance(item, dict)}
            if self.config.model not in models:
                raise AiClientHttpError(
                    f"Configured AI_MODEL is not available: {self.config.model}",
                    status_code=404,
                    response_body=f"Available models: {', '.join(sorted(model for model in models if model))}",
                    url=url,
                )
            return None

        url = f"{self.base_url}/models"
        headers = {}
        if self.config.api_key:
            headers["Authorization"] = f"Bearer {self.config.api_key}"
        try:
            response = await self._ensure_http_client().get(url, headers=headers)
        except Exception as exc:
            raise AiClientHttpError(f"AI model validation could not reach {url}: {exc}", url=url) from exc
        if response.status_code >= 400:
            raise AiClientHttpError(
                f"AI model validation failed with HTTP {response.status_code}",
                status_code=response.status_code,
                response_body=response.text,
                url=url,
            )
        data = response.json()
        models = {item.get("id") for item in data.get("data", []) if isinstance(item, dict)}
        if self.config.model not in models:
            raise AiClientHttpError(
                f"Configured AI_MODEL is not available: {self.config.model}",
                status_code=404,
                response_body=f"Available models: {', '.join(sorted(models))}",
                url=url,
            )

class AnthropicMessagesClient(AiClient):
    engine = "anthropic-messages"

    def __init__(self, config: AiClientConfig) -> None:
        self.config = config
        self.base_url = config.base_url.rstrip("/")
        self._client: httpx.AsyncClient | None = None

    def _ensure_http_client(self) -> httpx.AsyncClient:
        if self._client is None:
            self._client = httpx.AsyncClient(timeout=self.config.timeout_seconds, trust_env=False)
        return self._client

    async def close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    async def generate_text(
        self,
        *,
        messages: list[dict],
        temperature: float = 0.2,
        format_json: bool = False,
        max_tokens: int | None = None,
    ) -> tuple[str, str | None]:
        prompt_messages = _to_anthropic_messages(messages)
        if format_json:
            prompt_messages.append({"role": "user", "content": "Return only valid JSON."})
        payload = {
            "model": self.config.model,
            "messages": prompt_messages,
            "temperature": temperature,
            "max_tokens": max_tokens or self.config.max_output_tokens,
        }
        response = await self._post_messages(payload)
        return _anthropic_text(response), response.get("stop_reason")

    async def generate_json_from_bytes(
        self,
        *,
        data: bytes,
        mime_type: str,
        prompt: str,
        temperature: float = 0,
    ) -> tuple[str, str | None]:
        payload = {
            "model": self.config.model,
            "messages": [
                {
                    "role": "user",
                    "content": [
                        {
                            "type": "image",
                            "source": {
                                "type": "base64",
                                "media_type": mime_type,
                                "data": base64.b64encode(data).decode(),
                            },
                        },
                        {"type": "text", "text": prompt},
                    ],
                }
            ],
            "temperature": temperature,
            "max_tokens": self.config.max_output_tokens,
        }
        response = await self._post_messages(payload)
        return _anthropic_text(response), response.get("stop_reason")

    async def _post_messages(self, payload: dict[str, Any]) -> dict[str, Any]:
        async def request() -> dict[str, Any]:
            headers = {
                "anthropic-version": "2023-06-01",
                "content-type": "application/json",
            }
            if self.config.api_key:
                headers["x-api-key"] = self.config.api_key
            client = self._ensure_http_client()
            url = f"{self.base_url}/messages"
            safe_payload = _sanitize_payload(payload)
            safe_headers = _sanitize_headers(headers)
            logger.info(
                "ai_http_request",
                extra={"engine": self.engine, "url": url, "headers": safe_headers, "body": safe_payload},
            )
            response = await client.post(url, json=payload, headers=headers)
            if response.status_code >= 400:
                logger.error(
                    "ai_http_error",
                    extra={
                        "engine": self.engine,
                        "url": url,
                        "status_code": response.status_code,
                        "response_body": response.text,
                        "request_headers": safe_headers,
                        "request_body": safe_payload,
                        "classification": _classify_http_error(response.status_code, response.text),
                    },
                )
                raise AiClientHttpError(
                    f"AI messages request failed with HTTP {response.status_code}: {response.text[:500]}",
                    status_code=response.status_code,
                    response_body=response.text,
                    request_body=safe_payload,
                    url=url,
                )
            return response.json()

        return await _with_retry(request, self.config.max_retries)


def build_ai_client(config: AiClientConfig) -> AiClient:
    host = (urlparse(config.base_url).hostname or "").lower()
    if "googleapis.com" in host:
        return GoogleGenAiClient(config)
    if "anthropic.com" in host:
        return AnthropicMessagesClient(config)
    return ChatCompletionsClient(config)


async def _with_retry(operation, max_retries: int):
    last_exc = None
    for attempt in range(max_retries + 1):
        try:
            return await operation()
        except Exception as exc:
            last_exc = exc
            if attempt >= max_retries or not _retryable(exc):
                break
            import asyncio

            await asyncio.sleep(0.5 * (attempt + 1))
    raise last_exc


def _retryable(exc: Exception) -> bool:
    if isinstance(exc, AiClientHttpError):
        return exc.status_code is None or exc.status_code in {408, 429, 500, 502, 503, 504}
    if isinstance(exc, (httpx.TimeoutException, httpx.TransportError)):
        return True
    if isinstance(exc, httpx.HTTPStatusError):
        return exc.response.status_code in {408, 429, 500, 502, 503, 504}
    return True


def _messages_to_prompt(messages: list[dict]) -> str:
    parts: list[str] = []
    for message in messages:
        role = str(message.get("role") or "user").upper()
        content = message.get("content") or ""
        parts.append(f"{role}: {content}")
    return "\n\n".join(parts)


def _to_anthropic_messages(messages: list[dict]) -> list[dict]:
    normalized = []
    for message in messages:
        role = "assistant" if message.get("role") == "assistant" else "user"
        normalized.append({"role": role, "content": str(message.get("content") or "")})
    return normalized or [{"role": "user", "content": ""}]


def _anthropic_text(response: dict[str, Any]) -> str:
    parts = response.get("content") or []
    return "".join(part.get("text", "") for part in parts if part.get("type") == "text")


def _sanitize_headers(headers: dict[str, str]) -> dict[str, str]:
    return {key: ("<redacted>" if key.lower() in {"authorization", "x-api-key"} else value) for key, value in headers.items()}


def _sanitize_payload(value: Any) -> Any:
    if isinstance(value, dict):
        return {key: _sanitize_payload(child) for key, child in value.items()}
    if isinstance(value, list):
        return [_sanitize_payload(child) for child in value]
    if isinstance(value, str) and len(value) > 512:
        digest = hashlib.sha256(value.encode("utf-8")).hexdigest()
        return f"<string len={len(value)} sha256={digest}>"
    return value


def _classify_http_error(status_code: int, response_body: str) -> str:
    body = (response_body or "").lower()
    if status_code in {401, 403}:
        return "authentication"
    if status_code == 404 and "model" in body:
        return "model_not_found"
    if status_code == 400:
        return "invalid_payload"
    if status_code == 422:
        return "compatibility"
    if status_code >= 500:
        return "upstream_server_error"
    return "http_error"


def _classify_transport_error(exc: Exception) -> str:
    if isinstance(exc, httpx.TimeoutException):
        return "timeout"
    return "transport_error"


def _usage_summary(response: dict[str, Any]) -> dict[str, Any] | None:
    usage = response.get("usage")
    return usage if isinstance(usage, dict) else None


def _chat_completion_text_and_finish(response: dict[str, Any]) -> tuple[str, str | None]:
    choices = response.get("choices") if isinstance(response, dict) else None
    choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
    message = choice.get("message") if isinstance(choice, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if content is None:
        content = choice.get("text") if isinstance(choice, dict) else ""
    finish_reason = (
        choice.get("finish_reason")
        or response.get("done_reason")
        or response.get("finish_reason")
        or ("done" if response.get("done") is True else None)
    )
    return content or "", finish_reason


def _is_ollama_load_response(response: dict[str, Any], finish_reason: str | None) -> bool:
    if (finish_reason or "").lower() == "load":
        return True
    if not isinstance(response, dict):
        return False
    return str(response.get("done_reason") or "").lower() == "load"


def _ollama_response_text(response: dict[str, Any]) -> str:
    message = response.get("message") if isinstance(response, dict) else None
    content = message.get("content") if isinstance(message, dict) else None
    if isinstance(content, str) and content.strip():
        return content
    fallback = response.get("response") if isinstance(response, dict) else None
    if isinstance(fallback, str) and fallback.strip():
        return fallback
    return content or fallback or ""


def _ollama_finish_reason(response: dict[str, Any]) -> str | None:
    if not isinstance(response, dict):
        return None
    return response.get("done_reason") or response.get("finish_reason") or ("done" if response.get("done") is True else None)


def _validate_chat_completions_payload(payload: dict[str, Any]) -> None:
    if not payload.get("model"):
        raise AiClientHttpError("Invalid AI payload: model is required", request_body=_sanitize_payload(payload))
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AiClientHttpError("Invalid AI payload: messages must be a non-empty array", request_body=_sanitize_payload(payload))
    allowed_roles = {"system", "user", "assistant", "tool"}
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise AiClientHttpError(f"Invalid AI payload: messages[{index}] must be an object", request_body=_sanitize_payload(payload))
        if message.get("role") not in allowed_roles:
            raise AiClientHttpError(f"Invalid AI payload: messages[{index}].role is invalid", request_body=_sanitize_payload(payload))
        content = message.get("content")
        if not isinstance(content, (str, list)):
            raise AiClientHttpError(f"Invalid AI payload: messages[{index}].content must be a string or content array", request_body=_sanitize_payload(payload))
        if isinstance(content, list):
            for part_index, part in enumerate(content):
                if not isinstance(part, dict):
                    raise AiClientHttpError(
                        f"Invalid AI payload: messages[{index}].content[{part_index}] must be an object",
                        request_body=_sanitize_payload(payload),
                    )
                if part.get("type") == "image_url":
                    image_url = part.get("image_url")
                    if not (isinstance(image_url, dict) and isinstance(image_url.get("url"), str)):
                        raise AiClientHttpError(
                            f"Invalid AI payload: messages[{index}].content[{part_index}].image_url.url is required",
                            request_body=_sanitize_payload(payload),
                        )
    if "temperature" in payload and not isinstance(payload["temperature"], (int, float)):
        raise AiClientHttpError("Invalid AI payload: temperature must be numeric", request_body=_sanitize_payload(payload))
    if "max_tokens" in payload and (not isinstance(payload["max_tokens"], int) or payload["max_tokens"] <= 0):
        raise AiClientHttpError("Invalid AI payload: max_tokens must be a positive integer", request_body=_sanitize_payload(payload))


def _finish_reason(response: Any) -> str | None:
    try:
        candidates = getattr(response, "candidates", None) or []
        if candidates:
            reason = getattr(candidates[0], "finish_reason", None)
            return getattr(reason, "name", None) or (str(reason) if reason is not None else None)
    except Exception:
        pass
    return None


def _image_chat_content(*, data: bytes, mime_type: str, prompt: str) -> dict[str, Any]:
    # Ollama native vision format expects raw base64 strings in
    # messages[].images. Do not include a data URL prefix and do not use the
    # OpenAI image_url content-part shape here.
    return {
        "role": "user",
        "content": prompt,
        "images": [base64.b64encode(data).decode("ascii")],
    }


def _ollama_base_url(base_url: str) -> str:
    stripped = (base_url or "").rstrip("/")
    return stripped[:-3] if stripped.endswith("/v1") else stripped


def _looks_like_ollama_native_base_url(base_url: str) -> bool:
    parsed = urlparse(base_url or "")
    host = (parsed.hostname or "").lower()
    path = (parsed.path or "").rstrip("/")
    return path != "/v1" and (host in {"localhost", "127.0.0.1", "0.0.0.0"} or parsed.port == 11434)


def _chat_completions_url(base_url: str) -> str:
    base = (base_url or "").rstrip("/")
    if _looks_like_ollama_native_base_url(base):
        return f"{base}/v1/chat/completions"
    return f"{base}/chat/completions"


def _validate_ollama_vision_payload(payload: dict[str, Any]) -> None:
    if not payload.get("model"):
        raise AiClientHttpError("Invalid Ollama vision payload: model is required", request_body=_sanitize_payload(payload))
    if payload.get("stream") is not False:
        raise AiClientHttpError("Invalid Ollama vision payload: stream must be false", request_body=_sanitize_payload(payload))
    messages = payload.get("messages")
    if not isinstance(messages, list) or not messages:
        raise AiClientHttpError("Invalid Ollama vision payload: messages must be a non-empty array", request_body=_sanitize_payload(payload))
    for index, message in enumerate(messages):
        if not isinstance(message, dict):
            raise AiClientHttpError(f"Invalid Ollama vision payload: messages[{index}] must be an object", request_body=_sanitize_payload(payload))
        if message.get("role") not in {"user", "assistant", "system"}:
            raise AiClientHttpError(f"Invalid Ollama vision payload: messages[{index}].role is invalid", request_body=_sanitize_payload(payload))
        if not isinstance(message.get("content"), str):
            raise AiClientHttpError(f"Invalid Ollama vision payload: messages[{index}].content must be a string", request_body=_sanitize_payload(payload))
        images = message.get("images")
        if not isinstance(images, list) or not images or not all(isinstance(item, str) and item for item in images):
            raise AiClientHttpError(f"Invalid Ollama vision payload: messages[{index}].images must be a non-empty string array", request_body=_sanitize_payload(payload))
    options = payload.get("options")
    if not isinstance(options, dict):
        raise AiClientHttpError("Invalid Ollama vision payload: options must be an object", request_body=_sanitize_payload(payload))
    if "temperature" in options and not isinstance(options["temperature"], (int, float)):
        raise AiClientHttpError("Invalid Ollama vision payload: options.temperature must be numeric", request_body=_sanitize_payload(payload))
    if not isinstance(options.get("num_predict"), int) or options.get("num_predict") <= 0:
        raise AiClientHttpError("Invalid Ollama vision payload: options.num_predict must be a positive integer", request_body=_sanitize_payload(payload))


def _ollama_vision_payload_structure(payload: dict[str, Any]) -> dict[str, Any]:
    messages = payload.get("messages") or []
    first_message = messages[0] if messages and isinstance(messages[0], dict) else {}
    images = first_message.get("images") or []
    return {
        "model": payload.get("model"),
        "message_count": len(messages),
        "first_message_keys": sorted(first_message.keys()),
        "first_message_role": first_message.get("role"),
        "content_type": type(first_message.get("content")).__name__,
        "image_count": len(images) if isinstance(images, list) else 0,
        "image_base64_lengths": [len(image) for image in images if isinstance(image, str)],
        "stream": payload.get("stream"),
        "options_keys": sorted((payload.get("options") or {}).keys()),
    }


def _json_only_prompt(prompt: str) -> str:
    return (
        f"{prompt}\n\n"
        "Important: Return ONLY one valid JSON object. Do not include markdown, code fences, explanations, or any text outside JSON."
    )


def _append_json_instruction(messages: list[dict]) -> list[dict]:
    if not messages:
        return [{"role": "user", "content": "Return only valid JSON."}]
    copied = [dict(message) for message in messages]
    last = copied[-1]
    content = last.get("content")
    instruction = "\n\nReturn ONLY one valid JSON object. Do not include markdown or explanations."
    if isinstance(content, str):
        last["content"] = content + instruction
    else:
        copied.append({"role": "user", "content": "Return ONLY one valid JSON object. Do not include markdown or explanations."})
    return copied


def _should_retry_without_response_format(exc: AiClientHttpError) -> bool:
    if exc.status_code not in {400, 422}:
        return False
    body = (exc.response_body or "").lower()
    if not body:
        return True
    compatibility_markers = (
        "response_format",
        "format",
        "json schema",
        "invalid payload",
        "unsupported",
        "unknown field",
        "cannot unmarshal",
    )
    return any(marker in body for marker in compatibility_markers)
