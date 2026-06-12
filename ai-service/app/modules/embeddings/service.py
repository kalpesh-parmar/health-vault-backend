from __future__ import annotations

import asyncio
from hashlib import sha256
from typing import Optional

from sentence_transformers import SentenceTransformer


class EmbeddingService:
    def __init__(
        self,
        model_name: str = "all-MiniLM-L6-v2",
        batch_size: int = 32,
    ) -> None:
        self.model_name = model_name
        self.batch_size = batch_size
        self.model: Optional[SentenceTransformer] = None
        self._model_lock = asyncio.Lock()
        self._cache: dict[str, list[float]] = {}

    async def _load_model(self) -> SentenceTransformer:
        """
        Lazy-load the embedding model.
        Prevents FastAPI startup crashes on Windows with Torch.
        """

        if self.model is not None:
            return self.model

        async with self._model_lock:
            if self.model is not None:
                return self.model

            def load() -> SentenceTransformer:
                return SentenceTransformer(self.model_name)

            self.model = await asyncio.to_thread(load)

        return self.model

    async def embed_text(self, text: str) -> list[float]:
        vectors = await self.embed_texts([text])
        return vectors[0]

    async def embed_texts(self, texts: list[str]) -> list[list[float]]:
        if not texts:
            return []

        hashes = [self.content_hash(text) for text in texts]
        missing = [
            text
            for text, text_hash in zip(texts, hashes)
            if text_hash not in self._cache
        ]
        if missing:
            await self._embed_and_cache(missing)

        return [self._cache[text_hash] for text_hash in hashes]

    async def _embed_and_cache(self, texts: list[str]) -> None:
        model = await self._load_model()

        def encode() -> list[list[float]]:
            return model.encode(
                texts,
                batch_size=self.batch_size,
                normalize_embeddings=True,
                convert_to_numpy=True,
                show_progress_bar=False,
            ).tolist()

        vectors = await asyncio.to_thread(encode)
        for text, vector in zip(texts, vectors):
            self._cache[self.content_hash(text)] = vector

    def chunk_text(
        self,
        text: str,
        *,
        max_chars: int = 1200,
        overlap: int = 160,
    ) -> list[str]:
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
        return sha256(text.encode("utf-8")).hexdigest()

    async def warmup(self) -> None:
        """
        Optional model warmup.
        Call after app startup if needed.
        """

        model = await self._load_model()

        def warm() -> None:
            model.encode(
                ["warmup"],
                normalize_embeddings=True,
                show_progress_bar=False,
            )

        await asyncio.to_thread(warm)

    async def health_check(self) -> bool:
        try:
            model = await self._load_model()

            def test() -> None:
                model.encode(
                    ["health-check"],
                    normalize_embeddings=True,
                    show_progress_bar=False,
                )

            await asyncio.to_thread(test)

            return True

        except Exception:
            return False
