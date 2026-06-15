from __future__ import annotations

import pytest

from app.core.errors import ModelUnavailableError, OcrEmptyResultError
from app.modules.ocr.service import OcrService
from app.modules.vision.vision_service import VisionModelService
from app.settings import Settings


def _settings(**overrides) -> Settings:
    base = {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/health_vault",
        "AI_MODEL": "qwen3-vl:latest",
        "AI_BASE_URL": "http://localhost:11434/v1",
        "AI_API_KEY": "test-key",
        "STORAGE_PROVIDER": "s3",
        "PATIENT_DOCUMENTS_BUCKET": "patient-documents",
        "AWS_REGION": "us-east-1",
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)


def test_settings_require_single_ai_model() -> None:
    with pytest.raises(ValueError, match="AI_MODEL"):
        _settings(AI_MODEL="")


def test_settings_require_single_ai_endpoint() -> None:
    settings = _settings(AI_API_KEY="")
    assert settings.ai_api_key is None
    with pytest.raises(ValueError, match="AI_BASE_URL"):
        _settings(AI_BASE_URL="")


def test_settings_accept_arbitrary_model_identifier() -> None:
    settings = _settings(AI_MODEL="claude-sonnet-4", AI_BASE_URL="https://api.example.test/v1")

    assert settings.ai_model == "claude-sonnet-4"
    assert settings.ai_base_url == "https://api.example.test/v1"


def test_settings_resolve_explicit_storage_provider() -> None:
    assert _settings(STORAGE_PROVIDER="s3").resolve_storage_provider() == "s3"
    assert _settings(
        STORAGE_PROVIDER="gcp",
        GCP_STORAGE_BUCKET="patient-documents",
        GCP_CREDENTIALS_BASE64="e30=",
    ).resolve_storage_provider() == "gcp"


class _FailingVision:
    def status(self) -> dict:
        return {"engine": "chat-completions", "model": "qwen3-vl:latest"}

    async def extract_pdf(self, *_args, **_kwargs) -> dict:
        raise ModelUnavailableError("configured model failed")

    async def extract_image(self, *_args, **_kwargs) -> dict:
        raise ModelUnavailableError("configured model failed")


class _InvalidVision:
    def status(self) -> dict:
        return {"engine": "chat-completions", "model": "qwen3-vl:latest"}

    async def extract_pdf(self, *_args, **_kwargs) -> dict:
        return {
            "pages": [{"page": 1, "text": "", "lines": []}],
            "text": "",
            "fullText": "",
            "pageCount": 1,
            "processedPageCount": 1,
            "metrics": {"non_empty_pages": 0, "model": "qwen3-vl:latest"},
        }


class _InvalidOutputClient:
    engine = "chat-completions"

    async def generate_json_from_bytes(self, **_kwargs) -> tuple[str, str | None]:
        return "not json", "stop"

    async def validate_model_available(self) -> None:
        return None

    async def close(self) -> None:
        return None


class _ValidOutputClient:
    engine = "chat-completions"

    async def generate_json_from_bytes(self, **_kwargs) -> tuple[str, str | None]:
        return '{"pages":[{"page":1,"text":"Glucose 92","confidence":0.91}]}', "stop"

    async def validate_model_available(self) -> None:
        return None

    async def close(self) -> None:
        return None


class _MixedPageOutputClient:
    engine = "chat-completions"

    async def generate_json_from_bytes(self, *, prompt, **_kwargs) -> tuple[str, str | None]:
        if "page 1" in prompt:
            return "", "stop"
        return '{"pages":[{"page":2,"text":"HbA1c 5.6","confidence":0.88}]}', "stop"

    async def validate_model_available(self) -> None:
        return None

    async def close(self) -> None:
        return None


@pytest.mark.asyncio
async def test_model_failure_stops_processing() -> None:
    service = OcrService(_FailingVision(), max_pdf_pages=3, fail_on_empty=True)
    with pytest.raises(ModelUnavailableError):
        await service.extract_document_bytes(
            document_bytes=b"%PDF-1.4\n%%EOF",
            filename="scan.pdf",
            mime_type="application/pdf",
        )


@pytest.mark.asyncio
async def test_invalid_model_result_stops_processing() -> None:
    service = OcrService(_InvalidVision(), max_pdf_pages=3, fail_on_empty=True)
    with pytest.raises(OcrEmptyResultError):
        await service.extract_document_bytes(
            document_bytes=b"%PDF-1.4\n%%EOF",
            filename="scan.pdf",
            mime_type="application/pdf",
        )


@pytest.mark.asyncio
async def test_invalid_http_200_model_output_maps_to_ocr_error_not_503() -> None:
    service = VisionModelService(
        api_key="",
        base_url="http://122.174.67.117:11434/v1",
        model="qwen3-vl:latest",
        timeout_seconds=5,
        max_retries=0,
        max_output_tokens=128,
        min_text_chars=1,
        cache_size=0,
        max_inline_bytes=1024 * 1024,
    )
    service._client = _InvalidOutputClient()
    with pytest.raises(OcrEmptyResultError) as exc_info:
        await service.extract_image(b"fake-image", filename="scan.png", mime_type="image/png", max_pages=1)

    assert exc_info.value.status_code == 422
    assert exc_info.value.code == "ai_model_invalid_output"


@pytest.mark.asyncio
async def test_valid_http_200_model_output_completes_ocr_payload() -> None:
    service = VisionModelService(
        api_key="",
        base_url="http://122.174.67.117:11434/v1",
        model="qwen 3-vl:latest",
        timeout_seconds=5,
        max_retries=0,
        max_output_tokens=128,
        min_text_chars=1,
        cache_size=0,
        max_inline_bytes=1024 * 1024,
    )
    service._client = _ValidOutputClient()
    result = await service.extract_image(b"fake-image", filename="scan.png", mime_type="image/png", max_pages=1)

    assert result["metrics"]["non_empty_pages"] == 1
    assert result["fullText"] == "Glucose 92"


@pytest.mark.asyncio
async def test_pdf_vision_returns_partial_results_when_one_page_is_empty() -> None:
    service = VisionModelService(
        api_key="",
        base_url="http://122.174.67.117:11434/v1",
        model="qwen3-vl:latest",
        timeout_seconds=5,
        max_retries=0,
        max_output_tokens=128,
        min_text_chars=1,
        cache_size=0,
        max_inline_bytes=1024 * 1024,
        page_concurrency=2,
    )
    service._client = _MixedPageOutputClient()
    result = await service._extract_rendered_pdf_pages([(1, b"image-1"), (2, b"image-2")])

    assert result["metrics"]["non_empty_pages"] == 1
    assert result["metrics"]["page_errors"]
    assert "HbA1c 5.6" in result["fullText"]
