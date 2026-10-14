import asyncio
from unittest.mock import AsyncMock, MagicMock, patch
from uuid import uuid4
from pathlib import Path
import pytest

from app.container import Container
from app.core.errors import OcrStageFailureError
from app.services.pipeline.ocr_stage import OcrStageHandler, validate_ocr_result
from app.settings import Settings


def test_container_has_no_paddle_ocr():
    """Verify that Container initializes with paddle_ocr as None and no PaddleOCR engine."""
    settings = Settings()
    container = Container(settings)

    assert container.paddle_ocr is None
    assert container.ocr_stage_handler.paddle is None


@pytest.mark.asyncio
async def test_raster_page_uses_qwen_vl_exclusive(tmp_path: Path):
    """Verify that image OCR exclusively routes to Qwen3-VL and marks used_paddle_ocr as False."""
    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "Clinic Name: Uma Clinic\nPatient: Urmila Patel\nRx: MBSON SL 1-0-0",
        "confidence": 0.98,
        "lines": [
            {"text": "Clinic Name: Uma Clinic", "confidence": 0.98},
            {"text": "Patient: Urmila Patel", "confidence": 0.98},
            {"text": "Rx: MBSON SL 1-0-0", "confidence": 0.98},
        ],
        "finish_reason": "stop",
    })

    mock_paddle = MagicMock()
    mock_paddle.async_extract_text_from_bytes = AsyncMock()

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    test_image_file = tmp_path / "prescription.jpg"
    test_image_file.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)

    result = await handler.run_ocr(
        file_path=test_image_file,
        filename="prescription.jpg",
        job_id=uuid4(),
        file_key="uploads/prescription.jpg",
        current_pct=10,
        completed_stages=[],
        checkpoint_data={},
        mime_type="image/jpeg",
    )

    # Paddle should never be called
    mock_paddle.async_extract_text_from_bytes.assert_not_called()
    mock_vision.extract_image.assert_awaited()

    assert result["confidence"] >= 0.9
    assert "Uma Clinic" in result["fullText"]
    assert result["metrics"]["used_paddle_ocr"] is False
    assert result["metrics"]["used_qwen_vl"] is True
    assert result["metrics"]["used_ocr"] is True
    assert result["metrics"]["failed_page_count"] == 0
    assert result["pages"][0]["engine"] == "qwen_vl"
    assert result["pages"][0]["status"] == "SUCCESS"


@pytest.mark.asyncio
async def test_vision_failure_does_not_fallback_to_paddle(tmp_path: Path):
    """Verify that when Qwen3-VL fails, it safely marks the page FAILED without invoking PaddleOCR."""
    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(side_effect=RuntimeError("Ollama connection timed out"))

    mock_paddle = MagicMock()
    mock_paddle.async_extract_text_from_bytes = AsyncMock()

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    test_image_file = tmp_path / "failing_prescription.jpg"
    test_image_file.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)

    result = await handler.run_ocr(
        file_path=test_image_file,
        filename="failing_prescription.jpg",
        job_id=uuid4(),
        file_key="uploads/failing_prescription.jpg",
        current_pct=10,
        completed_stages=[],
        checkpoint_data={},
        mime_type="image/jpeg",
    )

    # PaddleOCR must NOT be called as fallback
    mock_paddle.async_extract_text_from_bytes.assert_not_called()

    # The result must reflect page failure
    assert result["pages"][0]["status"] == "FAILED"
    assert result["pages"][0]["engine"] == "none"
    assert result["metrics"]["used_paddle_ocr"] is False
    assert result["metrics"]["failed_page_count"] == 1
    assert "[PAGE 1 OCR FAILED - CLINICAL DATA UNREADABLE]" in result["fullText"]

    # Downstream validation must reject this output
    with pytest.raises(OcrStageFailureError):
        validate_ocr_result(result)


@pytest.mark.asyncio
async def test_vision_empty_response_fails_cleanly(tmp_path: Path):
    """Verify that an empty response from Qwen3-VL fails cleanly and triggers downstream validation error."""
    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock(return_value={
        "text": "",
        "confidence": 0.0,
        "lines": [],
        "finish_reason": "stop",
    })

    mock_paddle = MagicMock()
    mock_paddle.async_extract_text_from_bytes = AsyncMock()

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    test_image_file = tmp_path / "blank.jpg"
    test_image_file.write_bytes(b"\xff\xd8\xff\xe0" + b"\x00" * 100)

    result = await handler.run_ocr(
        file_path=test_image_file,
        filename="blank.jpg",
        job_id=uuid4(),
        file_key="uploads/blank.jpg",
        current_pct=10,
        completed_stages=[],
        checkpoint_data={},
        mime_type="image/jpeg",
    )

    mock_paddle.async_extract_text_from_bytes.assert_not_called()
    assert result["pages"][0]["status"].startswith("FAILED")
    assert result["metrics"]["failed_page_count"] == 1

    with pytest.raises(OcrStageFailureError):
        validate_ocr_result(result)


@pytest.mark.asyncio
async def test_digital_pdf_uses_direct_extraction_without_vision(tmp_path: Path):
    """Verify that born-digital PDFs extract via direct PyMuPDF text without invoking Qwen-VL or Paddle."""
    import fitz

    # Create a real 1-page born-digital PDF with realistic clinical content
    pdf_path = tmp_path / "digital_report.pdf"
    doc = fitz.open()
    page = doc.new_page()
    report_text = (
        "Patient Name: John Doe\n"
        "Age: 45 Years\n"
        "Gender: Male\n"
        "Date: 12/10/2026\n"
        "Doctor: Dr. Smith\n"
        "Hospital: City General Hospital\n"
        "Investigation: Complete Blood Count\n"
        "Hemoglobin: 14.5 g/dL (Normal Range: 13.0 - 17.0)\n"
        "WBC Count: 6500 cells/cumm (Normal Range: 4000 - 11000)\n"
        "Platelet Count: 250000 /cumm\n"
        "Status: Normal Report Verified"
    )
    page.insert_text((50, 50), report_text)
    doc.save(str(pdf_path))
    doc.close()

    mock_vision = MagicMock()
    mock_vision.extract_image = AsyncMock()

    mock_paddle = MagicMock()
    mock_paddle.async_extract_text_from_bytes = AsyncMock()

    handler = OcrStageHandler(
        s3_client=MagicMock(),
        vision_service=mock_vision,
        paddle_engine=mock_paddle,
    )

    result = await handler.run_ocr(
        file_path=pdf_path,
        filename="digital_report.pdf",
        job_id=uuid4(),
        file_key="uploads/digital_report.pdf",
        current_pct=10,
        completed_stages=[],
        checkpoint_data={},
        mime_type="application/pdf",
    )

    mock_vision.extract_image.assert_not_called()
    mock_paddle.async_extract_text_from_bytes.assert_not_called()

    assert result["metrics"]["used_direct_text"] is True
    assert result["metrics"]["used_ocr"] is False
    assert result["metrics"]["used_paddle_ocr"] is False
    assert result["metrics"]["used_qwen_vl"] is False
    assert "Complete Blood Count" in result["fullText"]
    assert "Hemoglobin: 14.5 g/dL" in result["fullText"]
    assert result["pages"][0]["engine"] == "pymupdf_direct"
    assert result["pages"][0]["status"] == "SUCCESS"
