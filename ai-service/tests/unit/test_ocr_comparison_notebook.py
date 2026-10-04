from __future__ import annotations

import json
from pathlib import Path

import pytest


@pytest.fixture
def notebook_path() -> Path:
    ai_service_dir = Path(__file__).resolve().parents[2]
    return ai_service_dir / "notebooks" / "ocr_engine_comparison.ipynb"


def test_notebook_file_exists(notebook_path: Path):
    assert notebook_path.exists(), f"Notebook not found at: {notebook_path}"
    assert notebook_path.stat().st_size > 0


def test_notebook_valid_json_schema(notebook_path: Path):
    content = notebook_path.read_text(encoding="utf-8")
    data = json.loads(content)
    assert "cells" in data
    assert "metadata" in data
    assert data.get("nbformat") == 4
    assert isinstance(data["cells"], list)
    assert len(data["cells"]) >= 7


def test_notebook_configuration_cell_contract(notebook_path: Path):
    data = json.loads(notebook_path.read_text(encoding="utf-8"))
    config_cell = None
    for cell in data["cells"]:
        if cell.get("cell_type") == "code":
            source = "".join(cell.get("source", []))
            if "1. USER CONFIGURATION" in source:
                config_cell = source
                break

    assert config_cell is not None, "Configuration cell not found in notebook"
    assert "DIRECTORY" in config_cell
    assert "FILENAME" in config_cell
    assert 'ENGINE = "paddleocr"' in config_cell
    assert "PDF_DPI = 150" in config_cell


def test_notebook_isolation_guarantee(notebook_path: Path):
    data = json.loads(notebook_path.read_text(encoding="utf-8"))
    code_cells = ["".join(cell.get("source", [])) for cell in data["cells"] if cell.get("cell_type") == "code"]
    combined_code = "\n".join(code_cells)

    # Asserts separate execution checks
    assert 'ENGINE.strip().lower() == "paddleocr"' in combined_code
    assert 'ENGINE.strip().lower() == "vlm"' in combined_code

    # Asserts NO QualityGate coupling or automatic fallback in executable code
    assert "QualityGate" not in combined_code
    assert "quality_gate" not in combined_code
    assert "fallback_reason" not in combined_code


def test_notebook_reuses_existing_codebase_assets(notebook_path: Path):
    data = json.loads(notebook_path.read_text(encoding="utf-8"))
    combined_code = "\n".join("".join(cell.get("source", [])) for cell in data["cells"])

    assert "from app.modules.ocr.paddle_engine import PaddleOcrEngine" in combined_code
    assert "from app.modules.vision.vision_service import VisionModelService" in combined_code
    assert "from app.services.pipeline.preprocessing import preprocess_document_image" in combined_code
    assert "from app.modules.ocr.cleanup import clean_ocr_text" in combined_code
    assert "from app.settings import get_settings" in combined_code


def test_generator_script_reproducibility():
    from scripts.build_ocr_comparison_notebook import create_notebook
    generated_path = create_notebook()
    assert generated_path.exists()
    assert generated_path.suffix == ".ipynb"
