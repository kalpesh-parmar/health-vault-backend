from __future__ import annotations

import asyncio
from dataclasses import dataclass, field

from app.infrastructure.db.session import Database
from app.infrastructure.storage.gcs import GcsStorageClient
from app.infrastructure.storage.s3 import S3StorageClient
from app.modules.chat.service import ChatService
from app.modules.documents.service import DocumentAiService
from app.modules.embeddings.service import EmbeddingService
from app.modules.extraction.service import ExtractionService
from app.modules.ocr.service import OcrService
from app.modules.rag.service import RagService
from app.modules.summary.service import SummaryService
from app.modules.vision.vision_service import VisionModelService
from app.modules.voice.service import VoiceService
from app.services.llm import LLMService, build_llm_service
from app.settings import Settings


@dataclass
class ModelManager:
    settings: Settings
    embeddings: EmbeddingService
    voice: VoiceService | None = None
    _voice_lock: asyncio.Lock = field(default_factory=asyncio.Lock)

    async def get_voice(self) -> VoiceService:
        if self.voice is not None:
            return self.voice
        async with self._voice_lock:
            if self.voice is None:
                self.voice = await asyncio.to_thread(
                    VoiceService,
                    self.settings.whisper_model,
                    self.settings.tts_model_name,
                )
            return self.voice


class Container:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.db = Database(settings.database_url)
        self.llm: LLMService = build_llm_service(settings)
        self.models = ModelManager(
            settings=settings,
            embeddings=EmbeddingService(settings.embedding_model, settings.embedding_batch_size),
        )

        self.storage_provider = settings.resolve_storage_provider()
        if self.storage_provider == "s3":
            self.storage = S3StorageClient(settings)
        else:
            self.storage = GcsStorageClient(settings)

        self.vision_model = VisionModelService(
            api_key=settings.ai_api_key or "",
            base_url=settings.ai_base_url,
            model=settings.ai_model,
            timeout_seconds=settings.ai_timeout_seconds,
            max_retries=settings.ai_max_retries,
            max_output_tokens=settings.ai_max_output_tokens,
            min_text_chars=settings.ai_min_text_chars,
            cache_size=settings.ai_cache_size,
            max_inline_bytes=settings.ai_max_inline_bytes,
            page_concurrency=settings.ai_page_concurrency,
        )

        self.ocr = OcrService(
            self.vision_model,
            max_pdf_pages=settings.max_pdf_pages,
            fail_on_empty=settings.ocr_fail_on_empty,
            min_direct_text_chars=settings.ai_min_text_chars,
        )
        self.summary = SummaryService(
            self.llm,
            model=settings.ai_model,
            chunk_chars=settings.summary_chunk_chars,
            max_chunks=settings.summary_max_chunks,
            num_predict=settings.summary_num_predict,
        )
        self.documents = DocumentAiService(
            self.ocr,
            self.summary,
            summary_from_vision=settings.summary_from_vision,
            slim_response=settings.ocr_slim_response,
        )
        self.extraction = ExtractionService(
            self.llm,
            settings.ai_model,
            settings.ai_model,
            settings.summary_num_predict,
        )
        self.rag = RagService(self.models.embeddings, settings.rag_top_k)
        self.chat = ChatService(self.llm, self.rag, settings.ai_model)
        from app.services.translation_service import TranslationService
        self.translation = TranslationService(settings)

    @property
    def vision(self):
        return self.vision_model

    async def start(self) -> None:
        await self.vision.warm_up()
        await self.translation.warm_up()

    async def stop(self) -> None:
        await self.llm.close()
        await self.vision.close()
        await self.db.close()
