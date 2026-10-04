from __future__ import annotations

import io
from unittest.mock import AsyncMock, MagicMock, patch
import pytest
from PIL import Image

from app.modules.validation.service import (
    InvalidDocumentFileError,
    MedicalValidationService,
)
from app.settings import Settings


def make_dummy_image_bytes(size: tuple[int, int] = (100, 100)) -> bytes:
    img = Image.new("RGB", size, color="white")
    buf = io.BytesIO()
    img.save(buf, format="JPEG")
    return buf.getvalue()


@pytest.fixture
def service():
    settings = Settings(
        database_url="postgresql://user:pass@localhost:5432/db",
        ai_model="llama3",
        ai_base_url="http://localhost:11434",
        storage_provider="s3",
        patient_documents_bucket="test-bucket",
        aws_region="us-east-1",
        validation_max_image_side=1200,
        ollama_keep_alive="15m",
    )
    storage = AsyncMock()
    return MedicalValidationService(settings, storage)


def test_preflight_validation_empty_bytes(service):
    with pytest.raises(InvalidDocumentFileError, match="empty"):
        service._validate_document_bytes(b"")


def test_preflight_validation_corrupted_short_bytes(service):
    with pytest.raises(InvalidDocumentFileError, match="corrupted or too small"):
        service._validate_document_bytes(b"not_doc")


def test_preflight_validation_unsupported_plain_text(service):
    raw = b"This is just some plain ASCII text that is clearly not a PDF or image file." * 5
    with pytest.raises(InvalidDocumentFileError, match="Unsupported or unreadable"):
        service._validate_document_bytes(raw)


def test_preflight_validation_magic_bytes(service):
    assert service._validate_document_bytes(b"%PDF-1.4 header...") == "pdf"
    assert service._validate_document_bytes(b"\xff\xd8\xff\xe0\x00\x10JFIF" + b"\x00" * 20) == "image"
    assert service._validate_document_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 20) == "image"
    assert service._validate_document_bytes(b"RIFF\x20\x00\x00\x00WEBPVP8 " + b"\x00" * 20) == "image"


def test_downscale_image_dimension_clamping(service):
    large_img_bytes = make_dummy_image_bytes((3000, 2000))
    downscaled = service._downscale_image(large_img_bytes, max_dim=1200)

    with Image.open(io.BytesIO(downscaled)) as img:
        w, h = img.size
        assert max(w, h) == 1200
        assert w == 1200
        assert h == 800


@pytest.mark.asyncio
async def test_adaptive_p1_early_exit_on_high_confidence(service):
    img_bytes = make_dummy_image_bytes()
    mock_p1_resp = {
        "isMedical": True,
        "confidence": 0.95,
        "documentType": "LAB_REPORT",
        "reason": "Blood panel findings",
    }

    mock_render = MagicMock(return_value=[(1, img_bytes)])

    with patch.object(service, "is_model_available", new_callable=AsyncMock, return_value=True), \
         patch("app.modules.validation.service._render_pdf_pages_to_png", mock_render), \
         patch.object(service, "_call_vision_model", new_callable=AsyncMock, return_value=mock_p1_resp):

        result = await service.validate_medical_document(
            file_bytes=b"%PDF-1.4 dummy valid report",
            file_name="multipage_lab.pdf",
            max_pages=3,
        )

        assert result.isMedical is True
        assert result.confidence == 0.95
        assert result.documentType == "LAB_REPORT"
        assert result.metrics.pages_used == 1
        # Early exit: _render_pdf_pages_to_png should only have been called ONCE for max_pages=1
        assert mock_render.call_count == 1
        mock_render.assert_called_once_with(b"%PDF-1.4 dummy valid report", max_pages=1)


@pytest.mark.asyncio
async def test_adaptive_p1_evaluates_additional_pages_on_ambiguous_confidence(service):
    img_bytes = make_dummy_image_bytes()
    mock_p1_resp = {
        "isMedical": True,
        "confidence": 0.65,  # < 0.85 ambiguous
        "documentType": "OTHER_MEDICAL_DOCUMENT",
        "reason": "Header unclear",
    }
    mock_multi_resp = {
        "isMedical": True,
        "confidence": 0.92,
        "documentType": "DISCHARGE_SUMMARY",
        "reason": "Discharge notes on page 2",
    }

    def fake_render(data, max_pages):
        if max_pages == 1:
            return [(1, img_bytes)]
        return [(1, img_bytes), (2, img_bytes)]

    with patch.object(service, "is_model_available", new_callable=AsyncMock, return_value=True), \
         patch("app.modules.validation.service._render_pdf_pages_to_png", side_effect=fake_render), \
         patch.object(service, "_call_vision_model", new_callable=AsyncMock, side_effect=[mock_p1_resp, mock_multi_resp]):

        result = await service.validate_medical_document(
            file_bytes=b"%PDF-1.4 dummy valid report",
            file_name="discharge.pdf",
            max_pages=2,
        )

        assert result.isMedical is True
        assert result.confidence == 0.92
        assert result.documentType == "DISCHARGE_SUMMARY"
        assert result.metrics.pages_used == 2


@pytest.mark.asyncio
async def test_vision_payload_options(service):
    mock_post = MagicMock()
    mock_post.status_code = 200
    mock_post.json.return_value = {
        "response": '{"isMedical": true, "confidence": 0.95, "documentType": "LAB_REPORT"}'
    }

    mock_client = AsyncMock()
    mock_client.post.return_value = mock_post
    mock_client.__aenter__.return_value = mock_client

    with patch("httpx.AsyncClient", return_value=mock_client):
        parsed = await service._call_vision_model(
            base64_images=["fake_b64"],
            base_url="http://localhost:11434",
            model_name="medgemma:4b",
            timeout_sec=10.0,
            validation_schema={},
        )
        assert parsed is not None
        assert parsed["isMedical"] is True

        # Check call arguments
        call_kwargs = mock_client.post.call_args.kwargs
        json_payload = call_kwargs["json"]
        assert json_payload["keep_alive"] == "15m"
        assert json_payload["options"]["num_predict"] == 64
        assert json_payload["options"]["temperature"] == 0.0
