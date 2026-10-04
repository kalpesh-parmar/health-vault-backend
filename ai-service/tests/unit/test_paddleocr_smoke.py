from __future__ import annotations

from pathlib import Path
import cv2
import fitz
import numpy as np
import pytest

from app.modules.ocr.paddle_engine import PaddleOcrEngine

GOLDEN_DOCS_DIR = Path(__file__).resolve().parent.parent / "fixtures" / "golden_docs"
MANJUBEN_PDF = GOLDEN_DOCS_DIR / "Manjuben Ranoliya.pdf"


@pytest.fixture(scope="module")
def paddle_engine() -> PaddleOcrEngine:
    engine = PaddleOcrEngine.get_instance(lang="en")
    assert engine.is_available(), "PaddleOcrEngine failed to initialize"
    return engine


@pytest.fixture(scope="module")
def manjuben_image() -> np.ndarray:
    assert MANJUBEN_PDF.exists(), f"Golden doc not found: {MANJUBEN_PDF}"
    with fitz.open(MANJUBEN_PDF) as doc:
        page = doc.load_page(0)
        pix = page.get_pixmap(dpi=150, alpha=False)
        img_bytes = pix.tobytes("jpeg", jpg_quality=88)

    img_array = np.frombuffer(img_bytes, np.uint8)
    img = cv2.imdecode(img_array, cv2.IMREAD_COLOR)
    assert img is not None and img.shape[0] > 0, "Failed to decode rendered JPEG page"
    return img


def test_paddleocr_environment_and_device(paddle_engine: PaddleOcrEngine):
    """Verify PaddleOCR is available, initialized, and configured on CPU."""
    assert paddle_engine.is_available() is True
    assert paddle_engine.device.lower() in ("cpu", "gpu:0", "cuda:0")


def test_paddleocr_smoke_manjuben_synchronous(paddle_engine: PaddleOcrEngine, manjuben_image: np.ndarray):
    """Verify synchronous OCR inference on Manjuben Ranoliya.pdf matches golden metrics."""
    res = paddle_engine.extract_text_from_image(manjuben_image)

    # 1. Line and character yield
    assert res["line_count"] == 69, f"Expected 69 lines, got {res['line_count']}"
    assert res["char_count"] >= 1000, f"Expected >= 1000 chars, got {res['char_count']}"

    # 2. Confidence assertions
    assert res["mean_confidence"] >= 0.95, f"Expected mean confidence >= 0.95, got {res['mean_confidence']}"
    assert res["min_confidence"] >= 0.60, f"Expected min confidence >= 0.60, got {res['min_confidence']}"

    # 3. Performance threshold (allow cold-start warm-up on CPU)
    assert res["elapsed_ms"] <= 45000, f"Expected latency <= 45,000ms, got {res['elapsed_ms']}ms"

    # 4. Critical clinical text preservation
    full_text = res["full_text"]
    assert "MANJULABEN RANOLIYA" in full_text
    assert "Dr. Hardik Suvagiya" in full_text
    assert "2,40,000" in full_text
    assert "19/06/2025" in full_text


@pytest.mark.asyncio
async def test_paddleocr_smoke_manjuben_asynchronous(paddle_engine: PaddleOcrEngine, manjuben_image: np.ndarray):
    """Verify asynchronous threadpool execution returns identical high-fidelity extraction."""
    res = await paddle_engine.async_extract_text(manjuben_image)

    assert res["line_count"] == 69
    assert res["char_count"] >= 1000
    assert res["mean_confidence"] >= 0.95
    assert "MANJULABEN RANOLIYA" in res["full_text"]


def test_paddleocr_empty_image_handling(paddle_engine: PaddleOcrEngine):
    """Verify empty or None image array returns safe empty result without throwing."""
    empty_img = np.zeros((0, 0, 3), dtype=np.uint8)
    res = paddle_engine.extract_text_from_image(empty_img)

    assert res["line_count"] == 0
    assert res["char_count"] == 0
    assert res["full_text"] == ""
    assert res["mean_confidence"] == 0.0


def test_parse_detection_item_standard_formats():
    """Verify standard 2-tuple PaddleOCR formats parse correctly."""
    box = [[10, 10], [50, 10], [50, 20], [10, 20]]
    # Tuple format
    parsed_tuple = PaddleOcrEngine._parse_detection_item([box, ("Patient Name: John", 0.985)], index=0)
    assert parsed_tuple is not None
    assert parsed_tuple[0] == "Patient Name: John"
    assert parsed_tuple[1] == 0.985
    assert parsed_tuple[2] == box

    # List format
    parsed_list = PaddleOcrEngine._parse_detection_item([box, ["Rx: Paracetamol 500mg", 0.9412]], index=1)
    assert parsed_list is not None
    assert parsed_list[0] == "Rx: Paracetamol 500mg"
    assert parsed_list[1] == 0.9412


def test_parse_detection_item_unpacking_exception_structure():
    """Verify single-element tuples that previously triggered 'ValueError: not enough values to unpack' are handled safely."""
    box = [[5, 5], [25, 5], [25, 15], [5, 15]]

    # 1-tuple text payload
    parsed_1tuple = PaddleOcrEngine._parse_detection_item([box, ("CBC+ESR+Reticulocytes",)], index=0)
    assert parsed_1tuple is not None
    assert parsed_1tuple[0] == "CBC+ESR+Reticulocytes"
    assert parsed_1tuple[1] == 0.5  # default confidence
    assert parsed_1tuple[2] == box

    # 1-element list text payload
    parsed_1list = PaddleOcrEngine._parse_detection_item([box, ["HbA1c"]], index=1)
    assert parsed_1list is not None
    assert parsed_1list[0] == "HbA1c"
    assert parsed_1list[1] == 0.5


def test_parse_detection_item_flexible_formats():
    """Verify string, flat-tuple, and dictionary representations parse cleanly."""
    box = [[0, 0], [10, 0], [10, 10], [0, 10]]

    # Direct string payload
    parsed_str = PaddleOcrEngine._parse_detection_item([box, "Direct Lab Heading"], index=0)
    assert parsed_str is not None
    assert parsed_str[0] == "Direct Lab Heading"
    assert parsed_str[1] == 0.5

    # Flat 3-tuple [box, text, conf]
    parsed_flat = PaddleOcrEngine._parse_detection_item([box, "Flat Format", 0.89], index=1)
    assert parsed_flat is not None
    assert parsed_flat[0] == "Flat Format"
    assert parsed_flat[1] == 0.89

    # Dict format
    parsed_dict = PaddleOcrEngine._parse_detection_item(
        {"box": box, "text": "Dict Entry", "confidence": 0.923}, index=2
    )
    assert parsed_dict is not None
    assert parsed_dict[0] == "Dict Entry"
    assert parsed_dict[1] == 0.923


def test_parse_detection_item_malformed_and_empty():
    """Verify malformed, empty, or whitespace detections return None without raising exceptions."""
    box = [[0, 0], [1, 0], [1, 1], [0, 1]]

    assert PaddleOcrEngine._parse_detection_item(None, 0) is None
    assert PaddleOcrEngine._parse_detection_item([], 1) is None
    assert PaddleOcrEngine._parse_detection_item([box, ""], 2) is None
    assert PaddleOcrEngine._parse_detection_item([box, ("   ", 0.95)], 3) is None
    assert PaddleOcrEngine._parse_detection_item([box, ()], 4) is None
    assert PaddleOcrEngine._parse_detection_item(12345, 5) is None


def test_extract_text_normalizes_mixed_and_malformed_raw_detections(paddle_engine: PaddleOcrEngine, monkeypatch):
    """Verify extract_text_from_image handles mixed detection structures and skips malformed items gracefully."""
    box1 = [[10, 10], [50, 10], [50, 20], [10, 20]]
    box2 = [[10, 30], [50, 30], [50, 40], [10, 40]]
    box3 = [[10, 50], [50, 50], [50, 60], [10, 60]]

    # Simulated raw PaddleOCR response with standard 2-tuple, 1-tuple (unpack bug shape), and a malformed item
    mock_raw = [[
        [box1, ("Valid Line One", 0.90)],
        [box2, ("Single Tuple Line Two",)],   # Would have caused ValueError: not enough values to unpack
        "Malformed Random Object",            # Malformed item
        [box3, "String Line Three"],
    ]]

    monkeypatch.setattr(paddle_engine, "_run_raw_ocr", lambda _img: mock_raw)

    dummy_img = np.ones((100, 100, 3), dtype=np.uint8)
    res = paddle_engine.extract_text_from_image(dummy_img)

    assert res["line_count"] == 3
    assert res["lines"][0]["text"] == "Valid Line One"
    assert res["lines"][0]["confidence"] == 0.90
    assert res["lines"][1]["text"] == "Single Tuple Line Two"
    assert res["lines"][1]["confidence"] == 0.5
    assert res["lines"][2]["text"] == "String Line Three"
    assert res["lines"][2]["confidence"] == 0.5
    assert "Valid Line One\nSingle Tuple Line Two\nString Line Three" == res["full_text"]
    assert res["char_count"] == len(res["full_text"])
    assert res["min_confidence"] == 0.5
    assert res["mean_confidence"] == round((0.90 + 0.5 + 0.5) / 3, 4)


def test_extract_text_structured_dict_with_numpy_arrays(paddle_engine: PaddleOcrEngine, monkeypatch):
    """Verify structured dictionary responses containing NumPy arrays do NOT raise ambiguous truth value errors."""
    mock_raw = [{
        "rec_texts": np.array(["Patient Name: Jane Doe", "Diagnosis: Migraine"]),
        "rec_scores": np.array([0.975, 0.892]),
        "rec_boxes": np.array([
            [[10.0, 10.0], [50.0, 10.0], [50.0, 20.0], [10.0, 20.0]],
            [[10.0, 30.0], [50.0, 30.0], [50.0, 40.0], [10.0, 40.0]],
        ]),
    }]

    monkeypatch.setattr(paddle_engine, "_run_raw_ocr", lambda _img: mock_raw)

    dummy_img = np.ones((100, 100, 3), dtype=np.uint8)
    res = paddle_engine.extract_text_from_image(dummy_img)

    assert res["line_count"] == 2
    assert res["lines"][0]["text"] == "Patient Name: Jane Doe"
    assert res["lines"][0]["confidence"] == 0.975
    assert isinstance(res["lines"][0]["box"], list)  # converted from numpy
    assert res["lines"][1]["text"] == "Diagnosis: Migraine"
    assert res["lines"][1]["confidence"] == 0.892
    assert res["mean_confidence"] == round((0.975 + 0.892) / 2, 4)


def test_extract_text_direct_dict_with_numpy_arrays(paddle_engine: PaddleOcrEngine, monkeypatch):
    """Verify single direct dict response with 'texts' and 'scores' NumPy arrays parses cleanly."""
    mock_raw = {
        "texts": np.array(["Clinic Header", "Dr. A Sharma"]),
        "scores": np.array([0.991, 0.954]),
        "boxes": np.array([
            [[0.0, 0.0], [10.0, 0.0], [10.0, 10.0], [0.0, 10.0]],
            [[0.0, 20.0], [10.0, 20.0], [10.0, 30.0], [0.0, 30.0]],
        ]),
    }

    monkeypatch.setattr(paddle_engine, "_run_raw_ocr", lambda _img: mock_raw)

    dummy_img = np.ones((100, 100, 3), dtype=np.uint8)
    res = paddle_engine.extract_text_from_image(dummy_img)

    assert res["line_count"] == 2
    assert res["lines"][0]["text"] == "Clinic Header"
    assert res["lines"][0]["confidence"] == 0.991
    assert res["lines"][1]["text"] == "Dr. A Sharma"
    assert res["lines"][1]["confidence"] == 0.954


def test_parse_detection_item_with_numpy_array():
    """Verify _parse_detection_item handles numpy array items without ambiguous truth value exceptions."""
    box_arr = np.array([[10, 10], [50, 10], [50, 20], [10, 20]])
    item = [box_arr, ("Numpy Box Line", np.float32(0.96))]

    parsed = PaddleOcrEngine._parse_detection_item(item, 0)
    assert parsed is not None
    assert parsed[0] == "Numpy Box Line"
    assert parsed[1] == 0.96
    assert isinstance(parsed[2], list)
