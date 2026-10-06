import pytest
from PIL import Image

from app.modules.validation.classifier import (
    ClassifierUnavailableError,
    MedicalDocumentClassifier,
    is_blank_page,
)


def test_is_blank_page_detection():
    # Pure white image
    white_img = Image.new("RGB", (200, 200), (255, 255, 255))
    assert is_blank_page(white_img) is True

    # Uniform grey image (std dev < 5.0)
    grey_img = Image.new("RGB", (200, 200), (128, 128, 128))
    assert is_blank_page(grey_img) is True

    # High variance image (checkered or noisy)
    noisy_img = Image.new("RGB", (200, 200), (0, 0, 0))
    for x in range(0, 200, 20):
        for y in range(0, 200, 20):
            noisy_img.putpixel((x, y), (255, 255, 255))
    assert is_blank_page(noisy_img) is False


def test_classifier_unavailable_on_invalid_path():
    clf = MedicalDocumentClassifier(model_path="nonexistent/path/to/model")
    with pytest.raises(ClassifierUnavailableError):
        clf.load()


def test_classifier_blank_page_skips_inference():
    clf = MedicalDocumentClassifier.get_instance("models/med-doc-classifier")
    clf.load()
    white_img = Image.new("RGB", (100, 100), (255, 255, 255))
    result = clf.classify_image_sync(white_img)
    assert result["is_blank"] is True
    assert result["label"] == "BLANK"
    assert result["p_medical"] == 0.0


def test_classifier_real_inference():
    clf = MedicalDocumentClassifier.get_instance("models/med-doc-classifier")
    clf.load()
    # Test on a prescription image fixture
    img_path = "tests/fixtures/golden_scanned/hi/hi_01_prescription.png"
    img = Image.open(img_path)
    result = clf.classify_image_sync(img)

    assert result["is_blank"] is False
    assert result["p_medical"] >= 0.90
    assert result["medical_value"] == "medical"
    assert 0.0 <= result["p_good"] <= 1.0
    assert "l2_key" in result
