import pytest
from unittest.mock import AsyncMock, MagicMock, patch
from PIL import Image

from app.modules.validation.service import (
    EvaluatedPage,
    InvalidDocumentFileError,
    MedicalValidationService,
)
from app.settings import Settings


@pytest.fixture
def service():
    settings = MagicMock(spec=Settings)
    settings.classifier_model_path = "models/med-doc-classifier"
    storage = MagicMock()
    return MedicalValidationService(settings=settings, storage=storage)


def test_select_pages_to_evaluate(service):
    # Empty
    assert service._select_pages_to_evaluate(0) == []
    # 1 page -> [0]
    assert service._select_pages_to_evaluate(1) == [0]
    # 2 pages -> [0, 1]
    assert service._select_pages_to_evaluate(2) == [0, 1]
    # 3 pages -> [0, 1, 2]
    assert service._select_pages_to_evaluate(3) == [0, 1, 2]
    # 4 pages -> [0, 1, 2, 3]
    assert service._select_pages_to_evaluate(4) == [0, 1, 2, 3]
    # 10 pages -> pages 1-3 plus last page (indices 0, 1, 2, 9)
    assert service._select_pages_to_evaluate(10) == [0, 1, 2, 9]


def test_ordered_decision_rules_rule1_all_blank(service):
    pages = [
        EvaluatedPage(page_number=1, label="BLANK", p_medical=0.0, l2_key="blank", p_good=0.0),
        EvaluatedPage(page_number=2, label="BLANK", p_medical=0.0, l2_key="blank", p_good=0.0),
    ]
    is_med, conf, reason = service._apply_ordered_decision_rules(pages)
    assert is_med is False
    assert conf == 0.99
    assert "blank" in reason.lower()


def test_ordered_decision_rules_rule2_anchor_page(service):
    # Page 1 lab report (0.95), Page 2 advertisement (0.10)
    pages = [
        EvaluatedPage(page_number=1, label="MEDICAL", p_medical=0.95, l2_key="lab_diagnostic_report", p_good=1.0),
        EvaluatedPage(page_number=2, label="ADVERTISEMENT", p_medical=0.10, l2_key="other_document", p_good=0.8),
    ]
    is_med, conf, reason = service._apply_ordered_decision_rules(pages)
    assert is_med is True
    assert conf == 0.95
    assert "verified clinical records" in reason.lower()


def test_ordered_decision_rules_rule3_predominantly_non_medical(service):
    # 3 pages: 2 non-med (tax/receipt), 1 weak receipt (0.62), no page >= 0.90
    pages = [
        EvaluatedPage(page_number=1, label="NON_MEDICAL", p_medical=0.04, l2_key="form", p_good=0.9),
        EvaluatedPage(page_number=2, label="NON_MEDICAL", p_medical=0.08, l2_key="invoice_bill", p_good=0.9),
        EvaluatedPage(page_number=3, label="MEDICAL", p_medical=0.62, l2_key="invoice_bill", p_good=0.9),
    ]
    # n_med = 1, n_active = 3 -> 1/3 < 0.33 is False (1/3 == 0.33333 > 0.33), let's test 1 med / 4 active
    pages4 = [
        EvaluatedPage(page_number=1, label="NON_MEDICAL", p_medical=0.04, l2_key="form", p_good=0.9),
        EvaluatedPage(page_number=2, label="NON_MEDICAL", p_medical=0.08, l2_key="form", p_good=0.9),
        EvaluatedPage(page_number=3, label="NON_MEDICAL", p_medical=0.10, l2_key="invoice_bill", p_good=0.9),
        EvaluatedPage(page_number=4, label="MEDICAL", p_medical=0.62, l2_key="invoice_bill", p_good=0.9),
    ]
    is_med, conf, reason = service._apply_ordered_decision_rules(pages4)
    assert is_med is False
    assert conf == round(1.0 - 0.62, 4)
    assert "predominantly non-medical" in reason.lower()


def test_ordered_decision_rules_rule4_pure_non_medical(service):
    pages = [
        EvaluatedPage(page_number=1, label="NON_MEDICAL", p_medical=0.05, l2_key="aadhaar_card", p_good=0.95),
    ]
    is_med, conf, reason = service._apply_ordered_decision_rules(pages)
    assert is_med is False
    assert conf == 0.95
    assert "clinical healthcare records" in reason.lower()


def test_ordered_decision_rules_rule4_pure_advertisement(service):
    pages = [
        EvaluatedPage(page_number=1, label="ADVERTISEMENT", p_medical=0.15, l2_key="other_document", p_good=0.9),
    ]
    is_med, conf, reason = service._apply_ordered_decision_rules(pages)
    assert is_med is False
    assert conf == 0.85
    assert "advertisement" in reason.lower()


def test_ordered_decision_rules_rule5_majority_medical(service):
    pages = [
        EvaluatedPage(page_number=1, label="MEDICAL", p_medical=0.75, l2_key="opd_consultation_record", p_good=0.8),
        EvaluatedPage(page_number=2, label="NON_MEDICAL", p_medical=0.30, l2_key="invoice_bill", p_good=0.8),
    ]
    is_med, conf, reason = service._apply_ordered_decision_rules(pages)
    assert is_med is True
    assert conf == 0.75
    assert "valid medical records" in reason.lower()


def test_ordered_decision_rules_rule6_fail_closed_unknown(service):
    pages = [
        EvaluatedPage(page_number=1, label="UNKNOWN", p_medical=0.45, l2_key="other_document", p_good=0.2),
    ]
    is_med, conf, reason = service._apply_ordered_decision_rules(pages)
    assert is_med is False
    assert conf == 0.55
    assert "unable to verify" in reason.lower()


@pytest.mark.asyncio
async def test_validate_medical_document_prescription_returns_null_doctype(service):
    # Test real end-to-end service call on sample prescription
    img_path = "tests/fixtures/golden_scanned/hi/hi_01_prescription.png"
    with open(img_path, "rb") as f:
        file_bytes = f.read()

    resp = await service.validate_medical_document(
        file_bytes=file_bytes,
        file_name="prescription.png",
    )

    assert resp.isMedical is True
    assert resp.confidence >= 0.90
    assert resp.documentType is None  # Must strictly be None!
    assert resp.method == "classifier"
    assert resp.model == "ekacare/med-doc-classifier"
    assert resp.metrics.used_ollama is False
    assert resp.metrics.pages_used == 1


@pytest.mark.asyncio
async def test_adaptive_exit_page1_anchor_skips_later_pages(service):
    """Confirm that when page 1 has p_medical >= 0.95 with total_pages > 3, only 1 page is evaluated."""
    import fitz

    doc = fitz.open()
    for _ in range(4):
        p = doc.new_page()
        p.insert_text((50, 50), "Sample text")
    pdf_bytes = doc.tobytes()
    doc.close()

    mock_eval = AsyncMock(
        return_value=EvaluatedPage(
            page_number=1,
            label="MEDICAL",
            p_medical=0.96,
            l2_key="opd_consultation_record",
            p_good=1.0,
        )
    )

    with patch.object(service, "_evaluate_single_page", mock_eval):
        resp = await service.validate_medical_document(
            file_bytes=pdf_bytes,
            file_name="4page_doc.pdf",
        )

    assert resp.isMedical is True
    assert resp.confidence == 0.96
    assert resp.metrics.pages_used == 1
    assert mock_eval.call_count == 1


@pytest.mark.asyncio
async def test_validate_medical_document_respects_max_pages_param(service):
    """Confirm that passing max_pages=1 evaluates only the first page even if p_medical < 0.95."""
    import fitz

    doc = fitz.open()
    for _ in range(4):
        p = doc.new_page()
        p.insert_text((50, 50), "Sample text")
    pdf_bytes = doc.tobytes()
    doc.close()

    mock_eval = AsyncMock(
        return_value=EvaluatedPage(
            page_number=1,
            label="MEDICAL",
            p_medical=0.70,
            l2_key="opd_consultation_record",
            p_good=1.0,
        )
    )

    with patch.object(service, "_evaluate_single_page", mock_eval):
        resp = await service.validate_medical_document(
            file_bytes=pdf_bytes,
            file_name="4page_doc.pdf",
            max_pages=1,
        )

    assert resp.metrics.pages_used == 1
    assert mock_eval.call_count == 1

