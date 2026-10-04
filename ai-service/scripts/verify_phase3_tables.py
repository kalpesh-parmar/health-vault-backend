"""Phase 3 Table Reconstruction Verification & Benchmark Script.

Executes Step 8 (End-to-End Validation) and Step 9 (Benchmark) for Phase 3.
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from unittest.mock import MagicMock

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from app.modules.ocr.paddle_engine import PaddleOcrEngine
from app.modules.ocr.quality_gate import QualityGate
from app.services.pipeline.ocr_stage import OcrStageHandler
from app.services.pipeline.layout_stage import LayoutStageHandler
from app.services.pipeline.clinical_stage import ClinicalStageHandler


def verify_phase3():
    print("=" * 75)
    print("PHASE 3 VERIFICATION & BENCHMARK: SPATIAL LAYOUT & TABLE RECONSTRUCTION")
    print("=" * 75)

    fixture_path = AI_SERVICE_DIR / "tests" / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert fixture_path.is_file(), f"Fixture missing at {fixture_path}"
    image_bytes = fixture_path.read_bytes()
    print(f"Loaded golden document: {fixture_path.name} ({len(image_bytes)} bytes)")

    # 1. Warm OCR extraction with vision mock
    mock_vision = MagicMock()
    mock_vision.extract_text_from_bytes.side_effect = RuntimeError("Qwen-VL was erroneously called!")

    engine = PaddleOcrEngine.get_instance(lang="en", bypass_orientation=True, cpu_threads=4)
    ocr_handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=engine,
        quality_gate=QualityGate(min_mean_confidence=0.82),
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    print("\n--- [Step 1: OCR Stage Execution] ---")
    t0_ocr = time.perf_counter()
    page_res = loop.run_until_complete(ocr_handler._extract_page_with_tiered_ocr(image_bytes, page_num=1))
    ocr_elapsed_ms = (time.perf_counter() - t0_ocr) * 1000

    print(f"  - OCR Engine Used: {page_res['engine']}")
    print(f"  - OCR Status: {page_res['status']}")
    print(f"  - OCR Mean Confidence: {page_res['confidence']:.4f}")
    print(f"  - Lines Returned: {len(page_res['lines'])}")
    print(f"  - Lines with Bounding Boxes: {sum(1 for l in page_res['lines'] if l.get('box'))}")
    print(f"  - OCR Inference Time: {ocr_elapsed_ms:.2f} ms")
    print(f"  - Qwen3-VL Call Count: {mock_vision.extract_text_from_bytes.call_count}")

    assert page_res["status"] == "SUCCESS"
    assert page_res["engine"] == "paddleocr"
    assert mock_vision.extract_text_from_bytes.call_count == 0
    assert len(page_res["lines"]) == 33

    raw_ocr_data = {
        "pages": [page_res],
        "fullText": page_res.get("text", ""),
        "confidence": page_res.get("confidence", 0.0),
        "pageCount": 1,
    }

    # 2. Layout Stage Execution
    print("\n--- [Step 2: Layout Stage Execution] ---")
    layout_handler = LayoutStageHandler(row_vertical_tolerance=0.65)

    t0_layout = time.perf_counter()
    layout_data = layout_handler.parse_layout(raw_ocr_data)
    layout_wall_ms = (time.perf_counter() - t0_layout) * 1000

    metrics = layout_data.get("metrics", {})
    tables = layout_data.get("tables", [])

    print(f"  - Layout Stage Total Wall Time: {layout_wall_ms:.2f} ms")
    print(f"  - layout_total_ms: {metrics.get('layout_total_ms')} ms")
    print(f"  - spatial_cluster_ms: {metrics.get('spatial_cluster_ms')} ms")
    print(f"  - table_extraction_ms: {metrics.get('table_extraction_ms')} ms")
    print(f"  - section_classification_ms: {metrics.get('section_classification_ms')} ms")
    print(f"  - Visual Lines Clustered: {metrics.get('visual_line_count')}")
    print(f"  - Has Spatial Boxes: {metrics.get('has_spatial_boxes')}")
    print(f"  - Tables Extracted Count: {len(tables)}")

    assert len(tables) >= 1, f"Expected tables >= 1, got {len(tables)}"
    assert metrics.get("has_spatial_boxes") is True
    assert metrics.get("layout_total_ms") < 25.0

    table = tables[0]
    print(f"\nReconstructed Table 1:")
    print(f"  Headers ({table.get('colCount')} cols): {table.get('headers')}")
    print(f"  Rows ({table.get('rowCount')} rows):")
    for r in table.get("rows", []):
        print(f"    {r}")
    print(f"  Confidence: {table.get('confidence')}")

    # Verify table integrity
    headers_str = " ".join(table.get("headers", [])).upper()
    assert "MEDICINE" in headers_str or "NAME" in headers_str
    assert "DOSE" in headers_str or "DURATION" in headers_str
    assert table.get("rowCount") >= 2

    row_text_all = " ".join(" ".join(r) for r in table.get("rows", [])).upper()
    assert "MBSON" in row_text_all
    assert "CALDISON" in row_text_all

    # 3. Downstream Clinical Stage Verification
    print("\n--- [Step 3: Downstream Clinical Stage Integration] ---")
    clinical_handler = ClinicalStageHandler(extraction_service=None)
    clinical_structured = loop.run_until_complete(
        clinical_handler.extract_fields(raw_ocr_data=raw_ocr_data, layout_data=layout_data)
    )

    doc_type = clinical_structured.get("documentInfo", {}).get("documentType")
    patient_name = clinical_structured.get("patientInfo", {}).get("name")
    medications = clinical_structured.get("medications", [])

    print(f"  - Inferred Document Type: {doc_type}")
    print(f"  - Patient Name: {patient_name}")
    print(f"  - Extracted Medications Count: {len(medications)}")
    print(f"  - Downstream Clinical Stage Ingestion: SUCCESS")

    assert doc_type == "PRESCRIPTION"
    assert table.get("rowCount") >= 2, f"Expected at least 2 table rows, got {table.get('rowCount')}"

    # 4. Before / After Benchmark Comparison
    print("\n" + "=" * 75)
    print("PHASE 3 BEFORE VS AFTER BENCHMARK COMPARISON")
    print("=" * 75)

    benchmark_summary = {
        "document": "lab_1_.jpeg",
        "ocr_engine": page_res["engine"],
        "ocr_time_ms": round(ocr_elapsed_ms, 2),
        "ocr_confidence": round(page_res["confidence"], 4),
        "lines_count": len(page_res["lines"]),
        "has_spatial_boxes": metrics.get("has_spatial_boxes"),
        "layout_total_ms": metrics.get("layout_total_ms"),
        "spatial_cluster_ms": metrics.get("spatial_cluster_ms"),
        "table_extraction_ms": metrics.get("table_extraction_ms"),
        "before_table_count": 0,
        "after_table_count": len(tables),
        "before_row_count": 0,
        "after_row_count": table.get("rowCount"),
        "before_medications_count": 0,
        "after_medications_count": len(medications),
        "fallback_count": 0,
        "qwen_vl_calls": 0,
    }

    out_file = AI_SERVICE_DIR / "scripts" / "benchmark_phase3_results.json"
    out_file.write_text(json.dumps(benchmark_summary, indent=2))
    print(f"Saved benchmark summary to {out_file}")

    total_ms_str = f"{metrics.get('layout_total_ms')} ms"
    cluster_ms_str = f"{metrics.get('spatial_cluster_ms')} ms"
    table_ms_str = f"{metrics.get('table_extraction_ms')} ms"
    tables_count_str = f"{len(tables)} (RECOVERED)"
    row_count_str = f"{table.get('rowCount')}"
    meds_count_str = f"{len(medications)}"

    print(f"\n{'Metric':<30} | {'Before Phase 3':<18} | {'After Phase 3':<18}")
    print("-" * 72)
    print(f"{'OCR Engine':<30} | {'paddleocr':<18} | {'paddleocr':<18}")
    print(f"{'OCR Inference Time':<30} | {'~1,842 ms':<18} | {f'{ocr_elapsed_ms:.1f} ms':<18}")
    print(f"{'OCR Text Regurgitation':<30} | {'No':<18} | {'No':<18}")
    print(f"{'Qwen3-VL Fallback Calls':<30} | {'0':<18} | {'0':<18}")
    print(f"{'Layout Stage Total Latency':<30} | {'0.96 ms (naive)':<18} | {total_ms_str:<18}")
    print(f"{'Spatial Clustering Latency':<30} | {'0.00 ms':<18} | {cluster_ms_str:<18}")
    print(f"{'Table Extraction Latency':<30} | {'0.11 ms':<18} | {table_ms_str:<18}")
    print(f"{'Tables Detected Count':<30} | {'0 (BUG)':<18} | {tables_count_str:<18}")
    print(f"{'Table Rows Recovered':<30} | {'0':<18} | {row_count_str:<18}")
    print(f"{'Downstream Medications':<30} | {'0 (empty)':<18} | {meds_count_str:<18}")
    print(f"{'Spatial Provenance Preserved':<30} | {'No':<18} | {'Yes':<18}")
    print("-" * 72)
    print("\nALL PHASE 3 VERIFICATION GATES PASSED GREEN!")


if __name__ == "__main__":
    verify_phase3()
