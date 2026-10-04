from __future__ import annotations

import asyncio
from hashlib import sha256
import logging
import re
from typing import Any, Optional
from urllib.parse import urlparse

import httpx

logger = logging.getLogger(__name__)

THINK_PATTERN = re.compile(r"<think>.*?</think>", re.DOTALL | re.IGNORECASE)


def strip_thinking(text: str) -> str:
    """Remove <think>...</think> reasoning traces from text before embedding."""
    if not text:
        return ""
    cleaned = THINK_PATTERN.sub("", text)
    return cleaned.strip()


def resolve_ollama_base_url(base_url: str | None) -> str:
    """Resolve base URL for Ollama native endpoints (/api/embed, /api/embeddings)."""
    raw = (base_url or "").strip()
    if not raw:
        return "http://192.168.21.176:11434"
    clean = raw.rstrip("/")
    if clean.endswith("/v1"):
        clean = clean[:-3]
    return clean


class EmbeddingService:
    """High-performance embedding service utilizing Ollama bge-m3:latest on RTX 4090.

    Replaces direct BAAI/bge-m3 and SentenceTransformers in-process loading with
    asynchronous HTTP calls to Ollama, maintaining 1024-dimension vector compatibility,
    in-memory SHA-256 caching, and reasoning trace stripping.
    """

    def __init__(
        self,
        base_url: str | None = None,
        model_name: str = "bge-m3:latest",
        batch_size: int = 32,
        timeout_seconds: float = 60.0,
        max_retries: int = 2,
    ) -> None:
        self.base_url = resolve_ollama_base_url(base_url)
        self.model_name = model_name
        self.batch_size = batch_size
        self.timeout_seconds = timeout_seconds
        self.max_retries = max_retries
        self.expected_dim = 1024

        # Backwards-compatible attribute for inspection/health checks
        self.model: str | None = model_name
        self._is_ready: bool = True
        self._cache: dict[str, list[float]] = {}
        self._client: Optional[httpx.AsyncClient] = None
        self._client_lock = asyncio.Lock()

    def _ensure_client(self) -> httpx.AsyncClient:
        if self._client is None or self._client.is_closed:
            self._client = httpx.AsyncClient(
                base_url=self.base_url,
                timeout=httpx.Timeout(self.timeout_seconds, connect=10.0),
                trust_env=False,
            )
        return self._client

    async def close(self) -> None:
        """Close the underlying HTTP client session."""
        if self._client is not None and not self._client.is_closed:
            await self._client.aclose()
            self._client = None

    @property
    def is_ready(self) -> bool:
        return self._is_ready

    async def embed_text(self, text: str) -> list[float]:
        """Embed a single text passage."""
        cleaned = strip_thinking(text or "")
        if not cleaned:
            return [0.0] * self.expected_dim
        vectors = await self.embed_texts([cleaned])
        return vectors[0] if vectors else [0.0] * self.expected_dim

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        """Embed multiple text passages with caching and batching."""
        if not texts:
            return []

        cleaned_texts = [strip_thinking(t or "") for t in texts]
        hashes = [self.content_hash(t) for t in cleaned_texts]

        # Check cache
        missing_indices: list[int] = []
        missing_texts: list[str] = []
        for idx, (t, h) in enumerate(zip(cleaned_texts, hashes)):
            if not t:
                self._cache[h] = [0.0] * self.expected_dim
            elif h not in self._cache:
                missing_indices.append(idx)
                missing_texts.append(t)

        if missing_texts:
            new_vectors = await self._embed_batch_with_retry(missing_texts)
            for idx, text, vec in zip(missing_indices, missing_texts, new_vectors):
                self._cache[hashes[idx]] = vec

        return [self._cache[h] for h in hashes]

    async def _embed_batch_with_retry(self, texts: list[str]) -> list[list[float]]:
        """Process texts in batches respecting self.batch_size and retry configuration."""
        all_vectors: list[list[float]] = []

        for i in range(0, len(texts), self.batch_size):
            batch = texts[i : i + self.batch_size]
            vectors = await self._request_embeddings(batch)
            all_vectors.extend(vectors)

        return all_vectors

    async def _request_embeddings(self, batch: list[str]) -> list[list[float]]:
        """Request embeddings for a batch from Ollama /api/embed (with fallback to /api/embeddings)."""
        client = self._ensure_client()
        last_error: Exception | None = None

        for attempt in range(self.max_retries + 1):
            try:
                # Primary: Ollama /api/embed (batch support)
                response = await client.post(
                    "/api/embed",
                    json={
                        "model": self.model_name,
                        "input": batch,
                        "keep_alive": -1,
                    },
                )

                if response.status_code == 200:
                    data = response.json()
                    raw_embeddings = data.get("embeddings") or []
                    if len(raw_embeddings) == len(batch):
                        return [self._normalize_dim(v) for v in raw_embeddings]

                # Fallback: if /api/embed returns 404, fallback to /api/embeddings per item
                if response.status_code == 404:
                    logger.info("Ollama /api/embed returned 404, using /api/embeddings fallback")
                    return await self._fallback_legacy_embeddings(client, batch)

                response.raise_for_status()

            except (httpx.TimeoutException, httpx.TransportError, httpx.HTTPStatusError) as exc:
                last_error = exc
                logger.warning(
                    "Ollama embedding request failed (attempt %d/%d): %s",
                    attempt + 1,
                    self.max_retries + 1,
                    exc,
                )
                if attempt < self.max_retries:
                    await asyncio.sleep(0.5 * (attempt + 1))
                else:
                    break

        logger.error(
            "All %d Ollama embedding attempts failed for model %s: %s",
            self.max_retries + 1,
            self.model_name,
            last_error,
        )
        raise RuntimeError(
            f"Failed to generate embeddings via Ollama ({self.model_name}): {last_error}"
        ) from last_error

    async def _fallback_legacy_embeddings(
        self, client: httpx.AsyncClient, batch: list[str]
    ) -> list[list[float]]:
        """Fallback for older Ollama versions supporting only /api/embeddings."""
        results: list[list[float]] = []
        for text in batch:
            resp = await client.post(
                "/api/embeddings",
                json={
                    "model": self.model_name,
                    "prompt": text,
                    "keep_alive": -1,
                },
            )
            resp.raise_for_status()
            data = resp.json()
            vector = data.get("embedding")
            if not isinstance(vector, list):
                raise ValueError(f"Invalid embedding response from Ollama: {data}")
            results.append(self._normalize_dim(vector))
        return results

    def _normalize_dim(self, vector: list[float]) -> list[float]:
        """Ensure vector matches target dimension (1024 for bge-m3)."""
        if len(vector) == self.expected_dim:
            return vector
        if len(vector) > self.expected_dim:
            return vector[: self.expected_dim]
        # Pad with 0.0 if shorter
        padded = list(vector)
        padded.extend([0.0] * (self.expected_dim - len(vector)))
        return padded

    def chunk_text(
        self,
        text: str,
        *,
        max_chars: int = 1200,
        overlap: int = 160,
    ) -> list[str]:
        """Chunk text with overlap, preserving existing token budget contracts."""
        cleaned = (text or "").strip()
        if not cleaned:
            return []

        chunks: list[str] = []
        start = 0

        while start < len(cleaned):
            end = min(len(cleaned), start + max_chars)
            chunk = cleaned[start:end].strip()

            if chunk:
                chunks.append(chunk)

            if end >= len(cleaned):
                break

            start = max(0, end - overlap)

        return chunks

    def content_hash(self, text: str) -> str:
        """Compute SHA-256 hash for cache keying."""
        return sha256(text.encode("utf-8")).hexdigest()

    async def warmup(self) -> None:
        """Warm up bge-m3:latest on Ollama and keep it loaded in VRAM."""
        try:
            logger.info("Warming up Ollama embedding model: %s", self.model_name)
            await self.embed_text("warmup")
            logger.info("Ollama embedding model warmup complete: %s", self.model_name)
        except Exception as exc:
            logger.warning("Embedding warmup ping failed (will load on first request): %s", exc)

    async def health_check(self) -> bool:
        """Verify Ollama embedding connectivity."""
        try:
            client = self._ensure_client()
            resp = await client.get("/api/tags", timeout=5.0)
            if resp.status_code == 200:
                models = [
                    m.get("name") or m.get("model")
                    for m in resp.json().get("models", [])
                    if isinstance(m, dict)
                ]
                base_target = self.model_name.split(":")[0]
                matched = any(
                    m == self.model_name or (m and m.startswith(f"{base_target}:"))
                    for m in models
                )
                if matched:
                    return True
            # Secondary check: quick embed
            vec = await self.embed_text("health-check")
            return len(vec) == self.expected_dim
        except Exception:
            return False
