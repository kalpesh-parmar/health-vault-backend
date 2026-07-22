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
        default=18 * 1024 * 1024,
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
    embedding_model: str = Field(
        default="all-MiniLM-L6-v2",
        alias="AI_EMBEDDING_MODEL",
        validation_alias=AliasChoices("AI_EMBEDDING_MODEL", "EMBEDDING_MODEL"),
    )

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
    max_pdf_pages: int = Field(default=25, alias="MAX_PDF_PAGES")
    summary_chunk_chars: int = Field(default=1800, alias="SUMMARY_CHUNK_CHARS")
    summary_max_chunks: int = Field(default=8, alias="SUMMARY_MAX_CHUNKS")
    summary_num_predict: int = Field(default=220, alias="SUMMARY_NUM_PREDICT")

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
        if not 0 <= self.ai_min_confidence <= 1:
            raise ValueError("AI_MIN_CONFIDENCE must be between 0 and 1")

        return self

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
