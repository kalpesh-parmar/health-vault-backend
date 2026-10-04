"""Diagnostic Probe for Phase 3a: Layout Stage Timing & Spatial Data Flow.

Instruments and measures:
1. End-to-end OCR extraction on lab_1_.jpeg to capture raw_ocr_data with bounding boxes.
2. Audit of bounding box data structures (points, formats, coordinate ranges).
3. Microsecond timing breakdown of existing LayoutStageHandler operations.
4. Detailed verification of the `tables=0` failure mode.
5. Spatial geometry distribution of text boxes across table columns.
"""
from __future__ import annotations

import asyncio
import json
import os
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


def run_diagnostic_probe():
    print("=" * 75)
    print("PHASE 3a DIAGNOSTIC PROBE: LAYOUT STAGE TIMING & SPATIAL DATA FLOW")
    print("=" * 75)

    fixture_path = AI_SERVICE_DIR / "tests" / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert fixture_path.is_file(), f"Missing fixture at {fixture_path}"
    image_bytes = fixture_path.read_bytes()
    print(f"Fixture loaded: {fixture_path.name} ({len(image_bytes)} bytes)")

    # 1. Warm OCR extraction
    engine = PaddleOcrEngine.get_instance(lang="en", bypass_orientation=True, cpu_threads=4)
    mock_vision = MagicMock()
    quality_gate = QualityGate(min_mean_confidence=0.82)
    ocr_handler = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision,
        paddle_engine=engine,
        quality_gate=quality_gate,
    )

    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    print("\n--- [Step 1: Extracting raw OCR data via OcrStageHandler] ---")
    t0_ocr = time.perf_counter()
    page_res = loop.run_until_complete(ocr_handler._extract_page_with_tiered_ocr(image_bytes, page_num=1))
    ocr_elapsed_ms = (time.perf_counter() - t0_ocr) * 1000
    print(f"OCR Execution Time: {ocr_elapsed_ms:.2f} ms")
    print(f"OCR Status: {page_res.get('status')}, Engine: {page_res.get('engine')}, Mean Conf: {page_res.get('confidence'):.4f}")

    raw_ocr_data = {
        "pages": [page_res],
        "fullText": page_res.get("text", ""),
        "confidence": page_res.get("confidence", 0.0),
        "pageCount": 1,
    }

    # 2. Audit Bounding Box Structure in raw_ocr_data
    print("\n--- [Step 2: Auditing Bounding Box Structure in raw_ocr_data] ---")
    lines = page_res.get("lines", [])
    print(f"Total lines returned in page_data['lines']: {len(lines)}")
    has_boxes = sum(1 for l in lines if l.get("box") is not None)
    print(f"Lines containing 'box' attribute: {has_boxes} / {len(lines)}")

    sample_lines = lines[:5]
    print("\nSample OCR lines with spatial data:")
    for idx, sl in enumerate(sample_lines):
        print(f"  Line {idx+1}: text={sl.get('text')!r}, conf={sl.get('confidence')}, box={sl.get('box')}")

    # Inspect coordinate geometry
    all_boxes = [l["box"] for l in lines if l.get("box")]
    min_x = min(min(p[0] for p in b) for b in all_boxes)
    max_x = max(max(p[0] for p in b) for b in all_boxes)
    min_y = min(min(p[1] for p in b) for b in all_boxes)
    max_y = max(max(p[1] for p in b) for b in all_boxes)
    print(f"Bounding Box Coordinate Bounds: X=[{min_x:.1f}, {max_x:.1f}], Y=[{min_y:.1f}, {max_y:.1f}]")

    # 3. Layout Stage Micro-Timing Breakdown
    print("\n--- [Step 3: Measuring Current LayoutStageHandler Sub-Spans] ---")
    layout_handler = LayoutStageHandler()

    # Repeat 100 iterations to get robust sub-millisecond p50/p95 timings
    n_iters = 100
    total_parse_times = []
    table_extract_times = []
    reorder_times = []
    noise_section_times = []

    page_text = page_res.get("text", "")
    page_lines = page_text.splitlines()

    for _ in range(n_iters):
        t0 = time.perf_counter()
        layout_res = layout_handler.parse_layout(raw_ocr_data)
        total_parse_times.append((time.perf_counter() - t0) * 1000)

        # Sub-span: _extract_tables_from_lines
        t1 = time.perf_counter()
        tables = layout_handler._extract_tables_from_lines(page_lines, 1)
        table_extract_times.append((time.perf_counter() - t1) * 1000)

        # Sub-span: _reorder_multi_column_lines
        t2 = time.perf_counter()
        reordered = layout_handler._reorder_multi_column_lines(page_lines)
        reorder_times.append((time.perf_counter() - t2) * 1000)

    import numpy as np
    print(f"Sub-Span Latency Over {n_iters} Iterations:")
    print(f"  layout_total_ms:              mean={np.mean(total_parse_times):.3f} ms, p50={np.median(total_parse_times):.3f} ms, p95={np.percentile(total_parse_times, 95):.3f} ms")
    print(f"  table_extraction_ms (naive):  mean={np.mean(table_extract_times):.3f} ms, p50={np.median(table_extract_times):.3f} ms, p95={np.percentile(table_extract_times, 95):.3f} ms")
    print(f"  column_reorder_ms (naive):    mean={np.mean(reorder_times):.3f} ms, p50={np.median(reorder_times):.3f} ms, p95={np.percentile(reorder_times, 95):.3f} ms")

    # 4. Detailed Audit of tables=0 failure mode
    print("\n--- [Step 4: Audit of Current Layout Output & tables=0 Root Cause] ---")
    print(f"Sections extracted: {len(layout_res['sections'])}")
    for s in layout_res["sections"]:
        print(f"  - Section: {s['title']} ({len(s['content'])} chars)")
    print(f"Paragraphs extracted: {len(layout_res['paragraphs'])}")
    print(f"Signatures extracted: {len(layout_res['signatures'])}")
    print(f"Marginal notes extracted: {len(layout_res['marginalNotes'])}")
    print(f"TABLES EXTRACTED: {len(layout_res['tables'])}")

    print("\nRoot Cause Analysis of tables=0:")
    print("  1. page_data['lines'] contains rich bounding boxes, but layout_stage.py:")
    print("     - lines 54-55: page_text = page_data.get('text', '')")
    print("     - lines = page_text.splitlines()")
    print("     - Compeletely ignores page_data['lines']!")
    print("  2. _extract_tables_from_lines splits lines by whitespace regex: re.split(r'\\s{2,}|\\t', line_str)")
    print("     - In lab_1_.jpeg, PaddleOCR outputs line-by-line fragments joined with single newline.")
    print("     - Each line string in page_text is a single token or column item (e.g. 'HEMOGLOBIN', '13.2', 'g/dL', '12.0 - 15.0')")
    print("     - Therefore len(cols) is 1, failing the condition: len(cols) >= 3!")
    print("     - Result: tables = 0!")

    # 5. Spatial clustering demonstration probe
    print("\n--- [Step 5: Spatial Clustering Feasibility Probe] ---")
    # Sort boxes vertically by top Y coordinate
    # Box format: [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
    def get_box_bounds(b):
        xs = [p[0] for p in b]
        ys = [p[1] for p in b]
        return min(xs), min(ys), max(xs), max(ys)

    boxes_with_text = []
    for l in lines:
        if l.get("box") and l.get("text"):
            bx1, by1, bx2, by2 = get_box_bounds(l["box"])
            boxes_with_text.append({
                "text": l["text"],
                "conf": l.get("confidence", 0.0),
                "x1": bx1, "y1": by1, "x2": bx2, "y2": by2,
                "cy": (by1 + by2) / 2.0,
                "cx": (bx1 + bx2) / 2.0,
                "height": by2 - by1,
            })

    # Sort by vertical center cy
    boxes_with_text.sort(key=lambda item: item["cy"])
    print(f"Total spatial items: {len(boxes_with_text)}")

    # Simple Y-overlap clustering into visual lines
    visual_lines = []
    for item in boxes_with_text:
        placed = False
        for vline in visual_lines:
            # Check vertical overlap
            line_cy = sum(b["cy"] for b in vline) / len(vline)
            avg_height = sum(b["height"] for b in vline) / len(vline)
            if abs(item["cy"] - line_cy) < avg_height * 0.65:
                vline.append(item)
                placed = True
                break
        if not placed:
            visual_lines.append([item])

    print(f"Clustered into {len(visual_lines)} visual horizontal lines.")

    # Sort each visual line horizontally by x1
    for vline in visual_lines:
        vline.sort(key=lambda b: b["x1"])

    multi_item_lines = [vl for vl in visual_lines if len(vl) >= 3]
    print(f"Visual lines with >= 3 horizontal columns: {len(multi_item_lines)}")
    print("\nSample multi-column clustered lines:")
    for vl in multi_item_lines[:6]:
        row_str = " | ".join(f"{b['text']} (x={b['x1']:.0f})" for b in vl)
        print(f"  [Row Y~{vl[0]['cy']:.0f}]: {row_str}")

    results_summary = {
        "ocr_elapsed_ms": ocr_elapsed_ms,
        "total_lines": len(lines),
        "lines_with_boxes": has_boxes,
        "layout_total_ms_mean": float(np.mean(total_parse_times)),
        "layout_total_ms_p50": float(np.median(total_parse_times)),
        "layout_total_ms_p95": float(np.percentile(total_parse_times, 95)),
        "table_extraction_ms_mean": float(np.mean(table_extract_times)),
        "table_extraction_ms_p50": float(np.median(table_extract_times)),
        "column_reorder_ms_mean": float(np.mean(reorder_times)),
        "column_reorder_ms_p50": float(np.median(reorder_times)),
        "tables_found_current": len(layout_res["tables"]),
        "visual_lines_clustered": len(visual_lines),
        "multi_column_rows_detected": len(multi_item_lines),
    }

    out_file = AI_SERVICE_DIR / "scripts" / "probe_layout_results.json"
    out_file.write_text(json.dumps(results_summary, indent=2))
    print(f"\nWrote probe results to {out_file}")
    return results_summary


if __name__ == "__main__":
    run_diagnostic_probe()
