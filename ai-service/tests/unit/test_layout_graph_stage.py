from __future__ import annotations

import io
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock
from uuid import uuid4

import fitz
import pytest
from PIL import Image

from app.services.pipeline.graph_stage import GraphStageHandler
from app.services.pipeline.layout_stage import LayoutStageHandler


def test_multi_column_reading_order_preserved():
    handler = LayoutStageHandler()
    lines = [
        "Left Column Heading      Right Column Heading",
        "Left item 1              Right item 1",
        "Left item 2              Right item 2",
    ]
    reordered = handler._reorder_multi_column_lines(lines)
    assert reordered[0] == "Left Column Heading"
    assert reordered[1] == "Left item 1"
    assert reordered[2] == "Left item 2"
    assert reordered[3] == "Right Column Heading"
    assert reordered[4] == "Right item 1"
    assert reordered[5] == "Right item 2"


def test_bordered_table_parsed_into_matrix():
    handler = LayoutStageHandler()
    raw_ocr_data = {
        "pages": [
            {
                "page": 1,
                "text": (
                    "CLINICAL INVESTIGATION REPORT\n"
                    "| Test Parameter | Result | Unit | Reference |\n"
                    "|---|---|---|---|\n"
                    "| Hemoglobin | 14.2 | g/dL | 12.0 - 17.5 |\n"
                    "| Fasting Glucose | 92 | mg/dL | 70 - 99 |\n"
                    "Physician Signature: Dr. Ramesh MD"
                ),
            }
        ]
    }
    result = handler.parse_layout(raw_ocr_data)
    assert len(result["tables"]) == 1
    table = result["tables"][0]
    assert table["headers"] == ["Test Parameter", "Result", "Unit", "Reference"]
    assert len(table["rows"]) == 2
    assert table["rows"][0][0] == "Hemoglobin"
    assert table["rows"][0][1] == "14.2"
    assert len(result["signatures"]) == 1
    assert "Dr. Ramesh" in result["signatures"][0]["text"]


def test_borderless_whitespace_table_parsed():
    handler = LayoutStageHandler()
    lines = [
        "Test Name        Result    Unit      Normal Range",
        "Total Leukocyte  6500      /mcL      4000 - 11000",
        "Platelet Count   250000    /mcL      150000 - 450000",
        "Serum Creatinine 0.9       mg/dL     0.6 - 1.2",
    ]
    tables = handler._extract_tables_from_lines(lines, page_num=1)
    assert len(tables) == 1
    assert len(tables[0]["rows"]) == 3
    assert tables[0]["rows"][0][0] == "Total Leukocyte"
    assert tables[0]["rows"][0][1] == "6500"


def test_noise_advertisements_filtered():
    handler = LayoutStageHandler()
    raw_ocr_data = {
        "pages": [
            {
                "page": 1,
                "text": (
                    "HOSPITAL DISCHARGE SUMMARY\n"
                    "SPONSORED: Flat 50% off on health checkups. Call 1800-000-000.\n"
                    "Patient: Ramesh Kumar\n"
                    "Diagnosis: Acute Gastritis\n"
                    "Download our app on PlayStore to track reports.\n"
                ),
            }
        ]
    }
    result = handler.parse_layout(raw_ocr_data)
    cleaned = result["cleanedText"]
    assert "Flat 50% off" not in cleaned
    assert "Download our app" not in cleaned
    assert "Ramesh Kumar" in cleaned


@pytest.mark.asyncio
async def test_figure_crop_saved_to_s3_with_pointer(tmp_path: Path):
    s3_client = MagicMock()
    s3_client.upload_bytes = AsyncMock(return_value="patient/doc/report.pdf.graph_0.png")
    handler = GraphStageHandler(s3_client=s3_client)

    # Create a PDF with an embedded wide image (ECG strip: 600x150 -> aspect ratio 4.0)
    from PIL import ImageDraw
    img = Image.new("RGB", (600, 150), color=(255, 255, 255))
    draw = ImageDraw.Draw(img)
    points = [(x, 75 + int(30 * ((x % 30) - 15) / 15)) for x in range(0, 600, 5)]
    draw.line(points, fill=(0, 0, 0), width=2)
    img_buf = io.BytesIO()
    img.save(img_buf, format="PNG")
    img_bytes = img_buf.getvalue()

    doc = fitz.open()
    page = doc.new_page()
    page.insert_image(fitz.Rect(50, 50, 450, 150), stream=img_bytes)
    pdf_path = tmp_path / "ecg_doc.pdf"
    pdf_path.write_bytes(doc.tobytes())
    doc.close()

    graphs = await handler.extract_graphs(
        file_path=pdf_path,
        file_key="ecg_doc.pdf",
        bucket="test-bucket",
    )

    assert len(graphs) >= 1
    ecg_graph = graphs[0]
    assert ecg_graph["graphType"] == "ecg_waveform_strip"
    assert "s3Key" in ecg_graph
    assert ecg_graph["s3Bucket"] == "test-bucket"
    s3_client.upload_bytes.assert_called_once()
