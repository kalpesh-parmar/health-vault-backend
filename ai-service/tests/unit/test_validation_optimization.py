from __future__ import annotations

import io
from unittest.mock import AsyncMock
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
        classifier_model_path="models/med-doc-classifier",
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


def test_page_selection_scheme(service):
    # Tests pages 1-3 plus last page (indices 0, 1, 2, total-1) capped at 5
    assert service._select_pages_to_evaluate(1) == [0]
    assert service._select_pages_to_evaluate(2) == [0, 1]
    assert service._select_pages_to_evaluate(3) == [0, 1, 2]
    assert service._select_pages_to_evaluate(4) == [0, 1, 2, 3]
    assert service._select_pages_to_evaluate(5) == [0, 1, 2, 4]
    assert service._select_pages_to_evaluate(20) == [0, 1, 2, 19]
