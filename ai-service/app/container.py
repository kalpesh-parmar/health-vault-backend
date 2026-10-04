from __future__ import annotations

import asyncio
from dataclasses import dataclass, field
import logging
import httpx

logger = logging.getLogger(__name__)

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
from app.services.language_detection_service import LanguageDetectionService
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
        ollama_base_url = settings.ollama_base_url or settings.ai_base_url
        self.models = ModelManager(
            settings=settings,
            embeddings=EmbeddingService(
                base_url=ollama_base_url,
                model_name=settings.embedding_model,
                batch_size=settings.embedding_batch_size,
                timeout_seconds=settings.ai_timeout_seconds,
                max_retries=settings.ai_max_retries,
            ),
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
            max_image_side=getattr(settings, "vlm_max_image_side", 1500),
            num_ctx=getattr(settings, "vlm_num_ctx", 4096),
            num_predict=getattr(settings, "vlm_num_predict", 1536),
        )

        self.ocr = OcrService(
            self.vision_model,
            max_pdf_pages=settings.max_pdf_pages,
            fail_on_empty=settings.ocr_fail_on_empty,
            min_direct_text_chars=settings.ai_min_text_chars,
        )
        chat_model = settings.chat_model or settings.medgemma_model or settings.ai_model
        summary_model = settings.chat_model or settings.ai_model
        self.summary = SummaryService(
            self.llm,
            model=summary_model,
            chunk_chars=max(settings.summary_chunk_chars, 3600),
            max_chunks=settings.summary_max_chunks,
            num_predict=max(settings.summary_num_predict, 1024),
        )
        self.documents = DocumentAiService(
            self.ocr,
            self.summary,
            summary_from_vision=settings.summary_from_vision,
            slim_response=settings.ocr_slim_response,
        )
        self.extraction = ExtractionService(
            self.llm,
            vision_model=settings.ai_model,
            chat_model=chat_model,
            num_predict=settings.extraction_num_predict,
        )
        self.rag = RagService(self.models.embeddings, settings.rag_top_k)
        self.chat = ChatService(self.llm, self.rag, chat_model)
        from app.services.translation_service import TranslationService
        self.translation = TranslationService(settings)
        self.language_detection = LanguageDetectionService()

        # Pipeline Stage Handlers & Orchestrator
        from app.infrastructure.db.repositories.job_repository import JobRepository
        from app.infrastructure.db.repositories.lab_result_repository import LabResultRepository
        from app.services.notifier import ProgressNotifier
        from app.services.pipeline.lifecycle_service import PipelineLifecycleService
        from app.services.pipeline.checkpoint_service import CheckpointService
        from app.modules.ocr.paddle_engine import PaddleOcrEngine
        from app.modules.ocr.cache import OcrResultCache
        from app.services.pipeline.ocr_stage import OcrStageHandler
        from app.services.pipeline.layout_stage import LayoutStageHandler
        from app.services.pipeline.graph_stage import GraphStageHandler
        from app.services.pipeline.clinical_stage import ClinicalStageHandler
        from app.services.pipeline.analysis_stage import AnalysisStageHandler
        from app.services.pipeline.summary_stage import SummaryStageHandler
        from app.services.pipeline.embedding_stage import EmbeddingStageHandler
        from app.services.pipeline.orchestrator import PipelineOrchestrator

        self.job_repo = JobRepository(self.db)
        self.lab_result_repo = LabResultRepository(self.db)
        self.notifier = ProgressNotifier(self.db)
        self.lifecycle_service = PipelineLifecycleService(self.job_repo, self.notifier)
        self.checkpoint_service = CheckpointService(self.job_repo, self.storage)

        self.paddle_ocr = PaddleOcrEngine.get_instance(
            enable_mkldnn=settings.paddle_enable_mkldnn,
            bypass_orientation=settings.paddle_bypass_orientation,
            cpu_threads=settings.paddle_cpu_threads,
            rec_batch_num=settings.paddle_rec_batch_num,
            max_workers=settings.paddle_max_workers,
            det_limit_side_len=settings.paddle_det_limit_side_len,
            use_gpu=settings.paddle_use_gpu,
        )
        self.ocr_cache = OcrResultCache.get_default()
        self.ocr_stage_handler = OcrStageHandler(
            self.storage,
            lifecycle=self.lifecycle_service,
            vision_service=self.vision_model,
            paddle_engine=self.paddle_ocr,
            min_direct_text_chars=settings.ai_min_text_chars,
            cache=self.ocr_cache,
            settings=settings,
        )
        self.layout_stage_handler = LayoutStageHandler()
        self.graph_stage_handler = GraphStageHandler(self.storage)
        self.clinical_stage_handler = ClinicalStageHandler(
            self.extraction,
            bypass_min_confidence=settings.clinical_heuristic_bypass_min_confidence,
        )
        self.analysis_stage_handler = AnalysisStageHandler()
        self.summary_stage_handler = SummaryStageHandler(self.summary, self.translation)
        self.embedding_stage_handler = EmbeddingStageHandler(self.models.embeddings)

        self.pipeline_orchestrator = PipelineOrchestrator(
            job_repo=self.job_repo,
            lifecycle_service=self.lifecycle_service,
            checkpoint_service=self.checkpoint_service,
            s3_client=self.storage,
            ocr_handler=self.ocr_stage_handler,
            layout_handler=self.layout_stage_handler,
            graph_handler=self.graph_stage_handler,
            clinical_handler=self.clinical_stage_handler,
            analysis_handler=self.analysis_stage_handler,
            summary_handler=self.summary_stage_handler,
            embedding_handler=self.embedding_stage_handler,
            lab_result_repo=self.lab_result_repo,
        )

    @property
    def vision(self):
        return self.vision_model

    async def _prewarm_ollama_models(self) -> None:
        """Pre-warm Ollama vision/classification models with keep_alive to avoid first-request loading penalty."""
        base_url = (self.settings.ollama_base_url or self.settings.ai_base_url or "").rstrip("/")
        if base_url.endswith("/v1"):
            base_url = base_url[:-3]
        if not base_url:
            return

        models_to_warm: list[str] = []
        for m in (self.settings.medgemma_model, self.settings.ai_model):
            if m and m not in models_to_warm:
                models_to_warm.append(m)

        timeout = min(15.0, self.settings.ai_timeout_seconds)
        try:
            async with httpx.AsyncClient(timeout=timeout) as client:
                for model_name in models_to_warm:
                    try:
                        payload = {
                            "model": model_name,
                            "prompt": "warmup",
                            "stream": False,
                            "keep_alive": self.settings.ollama_keep_alive,
                            "options": {"num_predict": 1},
                        }
                        resp = await client.post(f"{base_url}/api/generate", json=payload)
                        if resp.status_code == 200:
                            logger.info(
                                "Ollama model pre-warmed successfully: %s (keep_alive=%s)",
                                model_name,
                                self.settings.ollama_keep_alive,
                            )
                        else:
                            logger.debug(
                                "Ollama pre-warm returned HTTP %s for model %s",
                                resp.status_code,
                                model_name,
                            )
                    except Exception as exc:
                        logger.warning("Ollama pre-warm skipped for %s: %s", model_name, exc)
        except Exception as exc:
            logger.warning("Ollama client connection failed during pre-warm: %s", exc)

    async def start(self) -> None:
        if self.settings.lifespan_warmup_enabled:
            try:
                await self.paddle_ocr.async_warm_up(self.settings.lifespan_warmup_ocr_languages)
            except Exception as exc:
                logger.warning("Lifespan PaddleOCR warm-up warning: %s", exc)
            await self._prewarm_ollama_models()

        await self.vision.warm_up()
        await self.translation.warm_up()
        await self.language_detection.warm_up()
        await self.models.embeddings.warmup()

    async def stop(self) -> None:
        await self.llm.close()
        await self.vision.close()
        await self.models.embeddings.close()
        await self.db.close()
