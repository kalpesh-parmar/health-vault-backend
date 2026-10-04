from __future__ import annotations

from functools import lru_cache
from pathlib import Path
from typing import Literal, Any

from pydantic import AliasChoices, Field, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

AI_SERVICE_ROOT = Path(__file__).resolve().parents[1]
if (AI_SERVICE_ROOT / ".env").exists():
    ROOT_ENV_FILE = AI_SERVICE_ROOT / ".env"
else:
    PROJECT_ROOT = AI_SERVICE_ROOT.parent if AI_SERVICE_ROOT.name == "ai-service" else AI_SERVICE_ROOT
    ROOT_ENV_FILE = PROJECT_ROOT / ".env"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=str(ROOT_ENV_FILE),
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    app_name: str = "Health Vault Unified AI Service"
    environment: str = Field(default="development", alias="NODE_ENV")
    log_level: str = "INFO"
    cors_origins: list[str] = Field(default=["*"], alias="CORS_ORIGINS")

    @model_validator(mode="before")
    @classmethod
    def parse_cors_origins(cls, data: Any) -> Any:
        if isinstance(data, dict):
            val = data.get("CORS_ORIGINS") or data.get("cors_origins")
            if isinstance(val, str):
                parsed = [origin.strip() for origin in val.split(",") if origin.strip()]
                data["CORS_ORIGINS"] = parsed
                data["cors_origins"] = parsed

            val_langs = data.get("LIFESPAN_WARMUP_OCR_LANGUAGES") or data.get("lifespan_warmup_ocr_languages")
            if isinstance(val_langs, str):
                parsed_langs = [lang.strip() for lang in val_langs.split(",") if lang.strip()]
                data["LIFESPAN_WARMUP_OCR_LANGUAGES"] = parsed_langs
                data["lifespan_warmup_ocr_languages"] = parsed_langs
        return data

    database_url: str = Field(alias="DATABASE_URL")

    storage_provider: Literal["auto", "s3", "gcp", "aws"] = Field(default="auto", alias="STORAGE_PROVIDER")
    patient_documents_bucket: str = Field(default="patient-documents", alias="PATIENT_DOCUMENTS_BUCKET")
    gcp_storage_bucket: str | None = Field(default=None, alias="GCP_STORAGE_BUCKET")
    gcp_project_id: str | None = Field(default=None, alias="GCP_PROJECT_ID")
    gcp_credentials_base64: str | None = Field(default=None, alias="GCP_CREDENTIALS_BASE64")
    aws_region: str = Field(default="us-east-1", alias="AWS_REGION")
    aws_access_key_id: str | None = Field(default=None, alias="AWS_ACCESS_KEY_ID")
    aws_secret_access_key: str | None = Field(default=None, alias="AWS_SECRET_ACCESS_KEY")

    ai_model: str = Field(alias="AI_MODEL")
    chat_model: str | None = Field(default=None, alias="CHAT_MODEL")
    ai_base_url: str = Field(alias="AI_BASE_URL")
    ai_api_key: str | None = Field(
        default=None,
        alias="AI_API_KEY",
        validation_alias=AliasChoices("AI_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"),
    )
    ai_timeout_seconds: float = Field(default=90.0, alias="AI_TIMEOUT_SECONDS")
    ai_timeout_ms: int | None = Field(default=None, alias="AI_TIMEOUT_MS")
    ai_max_retries: int = Field(
        default=2,
        alias="AI_MAX_RETRIES",
        validation_alias=AliasChoices("AI_MAX_RETRIES", "AI_RETRIES", "GEMINI_MAX_RETRIES"),
    )
    ai_max_output_tokens: int = Field(
        default=8192,
        alias="AI_MAX_OUTPUT_TOKENS",
        validation_alias=AliasChoices("AI_MAX_OUTPUT_TOKENS", "GEMINI_MAX_OUTPUT_TOKENS"),
    )
    ai_page_concurrency: int = Field(
        default=4,
        alias="AI_PAGE_CONCURRENCY",
        validation_alias=AliasChoices("AI_PAGE_CONCURRENCY", "AI_CONCURRENCY", "QWEN_VL_CONCURRENCY"),
    )
    ai_max_inline_bytes: int = Field(
        default=150 * 1024 * 1024,
        alias="AI_MAX_INLINE_BYTES",
        validation_alias=AliasChoices("AI_MAX_INLINE_BYTES", "GEMINI_MAX_INLINE_BYTES"),
    )
    ai_min_text_chars: int = Field(
        default=8,
        alias="AI_MIN_TEXT_CHARS",
        validation_alias=AliasChoices("AI_MIN_TEXT_CHARS", "GEMINI_MIN_TEXT_CHARS"),
    )
    ai_min_confidence: float = Field(
        default=0.35,
        alias="AI_MIN_CONFIDENCE",
        validation_alias=AliasChoices("AI_MIN_CONFIDENCE", "GEMINI_MIN_CONFIDENCE"),
    )
    ai_cache_size: int = Field(
        default=64,
        alias="AI_CACHE_SIZE",
        validation_alias=AliasChoices("AI_CACHE_SIZE", "GEMINI_CACHE_SIZE"),
    )

    summary_from_vision: bool = Field(default=True, alias="SUMMARY_FROM_VISION")
    ocr_slim_response: bool = Field(default=False, alias="OCR_SLIM_RESPONSE")
    ocr_fail_on_empty: bool = Field(default=True, alias="OCR_FAIL_ON_EMPTY")
    ocr_router_min_confidence: float = Field(
        default=0.82,
        alias="OCR_ROUTER_MIN_CONFIDENCE",
        description="Minimum mean confidence threshold for primary PaddleOCR engine to accept without VLM fallback.",
    )
    ocr_script_detection_enabled: bool = Field(
        default=True,
        alias="OCR_SCRIPT_DETECTION_ENABLED",
        description="Enable pre-OCR script detection on page text hints to skip non-Latin pages from Paddle.",
    )
    ocr_concurrent_race_enabled: bool = Field(
        default=True,
        alias="OCR_CONCURRENT_RACE_ENABLED",
        description="Run PaddleOCR and VLM concurrently on raster pages and cancel the loser.",
    )
    paddle_timeout_seconds: float = Field(
        default=20.0,
        alias="PADDLE_TIMEOUT_SECONDS",
        description="Hard timeout in seconds for PaddleOCR page inference before falling back to VLM.",
    )
    paddle_max_workers: int = Field(
        default=4,
        alias="PADDLE_MAX_WORKERS",
        description="Number of worker processes in PaddleOCR process pool to allow true page parallelism.",
    )
    paddle_det_limit_side_len: int = Field(
        default=960,
        alias="PADDLE_DET_LIMIT_SIDE_LEN",
        description="Cap on PaddleOCR detection max side length to avoid abnormal memory and inference latency.",
    )
    paddle_use_gpu: bool | None = Field(
        default=None,
        alias="PADDLE_USE_GPU",
        description="Enable GPU for PaddleOCR if CUDA is available; None for auto-detection.",
    )
    vlm_suppress_thinking: bool = Field(
        default=True,
        alias="VLM_SUPPRESS_THINKING",
        description="Suppress chain-of-thought thinking loops in Qwen-VL via assistant prefill </think>.",
    )
    vlm_temperature: float = Field(
        default=0.0,
        alias="VLM_TEMPERATURE",
        description="Sampling temperature for VLM OCR fallback.",
    )
    vlm_validate_output: bool = Field(
        default=True,
        alias="VLM_VALIDATE_OUTPUT",
        description="Validate VLM output against reasoning markers, truncation, and loops.",
    )
    ocr_mark_ancillary_pages: bool = Field(
        default=False,
        alias="OCR_MARK_ANCILLARY_PAGES",
        description="Parse Page X of N from direct-text pages and mark pages beyond N as ancillary.",
    )
    paddle_enable_mkldnn: bool = Field(
        default=False,
        alias="PADDLE_ENABLE_MKLDNN",
        description="Enable OneDNN/MKL-DNN acceleration in PaddleOCR. Defaults to False on Windows.",
    )
    paddle_bypass_orientation: bool = Field(
        default=True,
        alias="PADDLE_BYPASS_ORIENTATION",
        description="Bypass orientation classification and unwarping models in PaddleOCR on upright scans to save CPU cycles.",
    )
    paddle_cpu_threads: int = Field(
        default=4,
        alias="PADDLE_CPU_THREADS",
        description="Number of CPU/OpenMP threads dedicated to PaddleOCR inference to prevent core contention.",
    )
    paddle_rec_batch_num: int = Field(
        default=16,
        alias="PADDLE_REC_BATCH_NUM",
        description="Batch size for PaddleOCR text line recognition to accelerate dense multi-line documents.",
    )
    vlm_max_image_side: int = Field(
        default=1500,
        alias="VLM_MAX_IMAGE_SIDE",
        description="Maximum image dimension (width or height) before proportional downscaling for vision model fallback.",
    )
    vlm_num_ctx: int = Field(
        default=4096,
        alias="VLM_NUM_CTX",
        description="Explicit context window size in tokens allocated for Ollama vision model evaluation.",
    )
    vlm_num_predict: int = Field(
        default=1536,
        alias="VLM_NUM_PREDICT",
        description="Maximum tokens to generate during vision model OCR fallback to prevent runaway generation.",
    )
    clinical_heuristic_bypass_min_confidence: float = Field(
        default=0.85,
        alias="CLINICAL_HEURISTIC_BYPASS_MIN_CONFIDENCE",
        description="Minimum confidence threshold required to bypass medgemma:4b LLM normalization in favor of fast-path heuristic extraction.",
    )
    embedding_model: str = Field(
        default="bge-m3:latest",
        alias="AI_EMBEDDING_MODEL",
        validation_alias=AliasChoices("AI_EMBEDDING_MODEL", "EMBEDDING_MODEL"),
    )

    # Preprocessing settings (Plan 3.2)
    preprocess_deskew_enabled: bool = Field(
        default=True,
        alias="PREPROCESS_DESKEW_ENABLED",
        description="Enable automatic OpenCV-based deskewing on rotated/skewed scans.",
    )
    preprocess_remove_shadows: bool = Field(
        default=False,
        alias="PREPROCESS_REMOVE_SHADOWS",
        description="Enable morphological background subtraction and shadow removal.",
    )
    preprocess_max_deskew_angle: float = Field(
        default=45.0,
        alias="PREPROCESS_MAX_DESKEW_ANGLE",
        description="Maximum rotation angle allowed during deskewing.",
    )

    @property
    def PREPROCESS_DESKEW_ENABLED(self) -> bool:
        return self.preprocess_deskew_enabled

    @property
    def PREPROCESS_REMOVE_SHADOWS(self) -> bool:
        return self.preprocess_remove_shadows

    @property
    def PREPROCESS_MAX_DESKEW_ANGLE(self) -> float:
        return self.preprocess_max_deskew_angle

    paddle_timeout_seconds: float = Field(
        default=30.0,
        alias="PADDLE_TIMEOUT_SECONDS",
        description="Maximum seconds to wait for PaddleOCR inference before fallback.",
    )

    # Quality Gate settings (Plan 3.3)
    quality_gate_max_fragment_ratio: float = Field(
        default=0.35,
        alias="QUALITY_GATE_MAX_FRAGMENT_RATIO",
        description="Maximum ratio of single-character non-numeric tokens before rejecting text.",
    )
    quality_gate_min_avg_token_len: float = Field(
        default=2.5,
        alias="QUALITY_GATE_MIN_AVG_TOKEN_LEN",
        description="Minimum average token length on pages with >10 tokens.",
    )
    quality_gate_min_valid_token_ratio: float = Field(
        default=0.35,
        alias="QUALITY_GATE_MIN_VALID_TOKEN_RATIO",
        description="Minimum ratio of tokens matching clinical/general lexicon on >30 char text.",
    )
    quality_gate_borderline_min_conf: float = Field(
        default=0.70,
        alias="QUALITY_GATE_BORDERLINE_MIN_CONF",
        description="Lower bound of borderline OCR confidence range.",
    )
    quality_gate_borderline_max_conf: float = Field(
        default=0.85,
        alias="QUALITY_GATE_BORDERLINE_MAX_CONF",
        description="Upper bound of borderline OCR confidence range.",
    )

    @property
    def QUALITY_GATE_MAX_FRAGMENT_RATIO(self) -> float:
        return self.quality_gate_max_fragment_ratio

    @property
    def QUALITY_GATE_MIN_AVG_TOKEN_LEN(self) -> float:
        return self.quality_gate_min_avg_token_len

    @property
    def QUALITY_GATE_MIN_VALID_TOKEN_RATIO(self) -> float:
        return self.quality_gate_min_valid_token_ratio

    @property
    def QUALITY_GATE_BORDERLINE_MIN_CONF(self) -> float:
        return self.quality_gate_borderline_min_conf

    @property
    def QUALITY_GATE_BORDERLINE_MAX_CONF(self) -> float:
        return self.quality_gate_borderline_max_conf

    chat_concurrency: int = Field(default=4, alias="CHAT_CONCURRENCY")
    embedding_batch_size: int = Field(default=32, alias="EMBEDDING_BATCH_SIZE")
    voice_concurrency: int = Field(default=2, alias="VOICE_CONCURRENCY")
    rag_top_k: int = Field(default=4, alias="RAG_TOP_K")

    whisper_model: str = Field(default="small", alias="WHISPER_MODEL")
    tts_model_name: str = Field(
        default="tts_models/en/ljspeech/tacotron2-DDC", alias="TTS_MODEL_NAME"
    )
    realtime_voice_enabled: bool = Field(default=True, alias="VOICE_REALTIME_ENABLED")

    translation_model_name: str = Field(
        default="ai4bharat/indictrans2-en-indic-dist-200M", alias="TRANSLATION_MODEL_NAME"
    )
    hf_token: str | None = Field(default=None, alias="HF_TOKEN")
    translation_num_beams: int = Field(default=1, alias="TRANSLATION_NUM_BEAMS")

    worker_poll_interval_seconds: float = 1.0
    job_lock_seconds: int = 900
    internal_service_key: str = Field(default="change-me-internal-service-key", alias="INTERNAL_SERVICE_KEY")
    pg_notify_channel: str = Field(default="health_vault_sse_events", alias="PG_NOTIFY_CHANNEL")
    worker_concurrency: int = Field(default=2, alias="WORKER_CONCURRENCY")
    worker_mode: str = Field(default="standalone", alias="WORKER_MODE")
    worker_heartbeat_interval_seconds: float = Field(default=15.0, alias="WORKER_HEARTBEAT_INTERVAL_SECONDS")
    worker_heartbeat_stale_seconds: float = Field(default=180.0, alias="WORKER_HEARTBEAT_STALE_SECONDS")
    worker_reconciler_interval_seconds: float = Field(default=180.0, alias="WORKER_RECONCILER_INTERVAL_SECONDS")
    max_pdf_pages: int = Field(default=25, alias="MAX_PDF_PAGES")
    summary_chunk_chars: int = Field(default=1800, alias="SUMMARY_CHUNK_CHARS")
    summary_max_chunks: int = Field(default=8, alias="SUMMARY_MAX_CHUNKS")
    summary_num_predict: int = Field(default=220, alias="SUMMARY_NUM_PREDICT")
    extraction_num_predict: int = Field(default=1024, alias="EXTRACTION_NUM_PREDICT")
    ollama_keep_alive: str = Field(default="15m", alias="OLLAMA_KEEP_ALIVE")
    lifespan_warmup_enabled: bool = Field(default=True, alias="LIFESPAN_WARMUP_ENABLED")
    lifespan_warmup_ocr_languages: list[str] = Field(
        default=["en", "devanagari", "ta"], alias="LIFESPAN_WARMUP_OCR_LANGUAGES"
    )
    validation_max_image_side: int = Field(default=1200, alias="VALIDATION_MAX_IMAGE_SIDE")

    medgemma_model: str = Field(default="medgemma:4b", alias="MEDGEMMA_MODEL")
    medgemma_max_pages: int = Field(default=2, alias="MEDGEMMA_MAX_PAGES")
    medgemma_timeout_ms: int = Field(default=120000, alias="MEDGEMMA_TIMEOUT_MS")
    medgemma_min_confidence: float = Field(default=0.6, alias="MEDGEMMA_MIN_CONFIDENCE")
    medgemma_fallback: str = Field(default="text_classifier", alias="MEDGEMMA_FALLBACK")
    ollama_base_url: str | None = Field(default=None, alias="OLLAMA_BASE_URL")

    @model_validator(mode="after")
    def validate_required_configuration(self) -> "Settings":
        missing: list[str] = []

        if not self.ai_model.strip():
            missing.append("AI_MODEL")
        if not self.ai_base_url.strip():
            missing.append("AI_BASE_URL")
        if isinstance(self.ai_api_key, str) and not self.ai_api_key.strip():
            self.ai_api_key = None
        resolved_storage = self.resolve_storage_provider()
        if resolved_storage == "gcp":
            if not self.effective_gcp_bucket:
                missing.append("GCP_STORAGE_BUCKET or PATIENT_DOCUMENTS_BUCKET")
            if not self.gcp_credentials_base64:
                missing.append("GCP_CREDENTIALS_BASE64")
        if resolved_storage == "s3":
            if not self.patient_documents_bucket:
                missing.append("PATIENT_DOCUMENTS_BUCKET")
            if not self.aws_region:
                missing.append("AWS_REGION")

        if missing:
            raise ValueError("Missing required configuration: " + ", ".join(missing))

        if self.ai_timeout_ms is not None:
            self.ai_timeout_seconds = self.ai_timeout_ms / 1000
        if self.ai_timeout_seconds <= 0:
            raise ValueError("AI_TIMEOUT_SECONDS must be greater than zero")
        if self.ai_max_retries < 0:
            raise ValueError("AI_MAX_RETRIES must be zero or greater")
        if self.ai_max_output_tokens <= 0:
            raise ValueError("AI_MAX_OUTPUT_TOKENS must be greater than zero")
        if self.ai_page_concurrency <= 0:
            raise ValueError("AI_PAGE_CONCURRENCY must be greater than zero")
        if self.ai_max_inline_bytes <= 0:
            raise ValueError("AI_MAX_INLINE_BYTES must be greater than zero")
        if self.ai_min_text_chars < 0:
            raise ValueError("AI_MIN_TEXT_CHARS must be zero or greater")
        # Normalize embedding model identifier to Ollama model tag (bge-m3:latest)
        raw_emb = (self.embedding_model or "").strip()
        if raw_emb.lower() in ("bge-m3", "baai/bge-m3", "bge-m3:latest"):
            self.embedding_model = "bge-m3:latest"
        elif raw_emb:
            self.embedding_model = raw_emb
        else:
            self.embedding_model = "bge-m3:latest"

        return self

    @property
    def effective_chat_model(self) -> str:
        return (self.chat_model or "").strip() or self.ai_model

    @property
    def effective_gcp_bucket(self) -> str | None:
        return self.gcp_storage_bucket or self.patient_documents_bucket

    def resolve_storage_provider(self) -> Literal["s3", "gcp"]:
        configured = (self.storage_provider or "auto").strip().lower()
        has_gcp = bool(self.effective_gcp_bucket and self.gcp_credentials_base64)
        has_s3 = bool(self.patient_documents_bucket and (self.aws_access_key_id or self.aws_region))

        if configured == "gcp":
            return "gcp"
        if configured in ("s3", "aws"):
            return "s3"
        if has_gcp:
            return "gcp"
        if has_s3:
            return "s3"
        raise ValueError(
            "Storage is not configured. Set STORAGE_PROVIDER=s3 or STORAGE_PROVIDER=gcp "
            "with the required bucket and credentials."
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()
