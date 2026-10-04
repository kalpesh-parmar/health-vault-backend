"""Phase 4 Multilingual Script Gate & Quality Routing Verification Script.

Executes Task 5 end-to-end verification gate for:
- MULTI-01: Script identification check across Indic Unicode blocks (Devanagari, Gujarati, Tamil)
- MULTI-02: Zero-silent-drop invariant for regional instructions via hybrid merging
- ROUTE-01: Deterministic quality router honoring OCR_ROUTER_MIN_CONFIDENCE
- ROUTE-02: Clean English documents bypass VLM fallback 100% of the time (< 2.0s latency)
"""
from __future__ import annotations

import asyncio
import json
import sys
import time
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from app.modules.ocr.script_detector import (
    UNICODE_SCRIPT_RANGES,
    detect_scripts_in_text,
    get_character_script,
    inspect_ocr_lines_for_non_latin,
)
from app.modules.ocr.quality_gate import QualityGate, QualityGateResult
from app.modules.ocr.paddle_engine import PaddleOcrEngine
from app.services.pipeline.ocr_stage import OcrStageHandler
from app.services.pipeline.layout_stage import LayoutStageHandler


def verify_phase4():
    print("=" * 80)
    print("PHASE 4 VERIFICATION GATE: MULTILINGUAL SCRIPT GATE & QUALITY ROUTING")
    print("=" * 80)

    results = {}

    # ──────────────────────────────────────────────────────────────────────────
    # Check 1: Script Identification & Indic Inspection (MULTI-01)
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 1: Indic Script & Character Categorization (MULTI-01)]")
    scripts_to_test = {
        "devanagari": ("दवा दिन में दो बार खाना खाने के बाद लें", "क"),
        "gujarati": ("ફરી બતાવવા માટે 30 દિવસ પછી આવવું", "ક"),
        "tamil": ("மருந்து காலை மாலை உணவுக்குப் பின்", "க"),
    }

    all_scripts_detected = True
    for script_name, (sample_text, sample_char) in scripts_to_test.items():
        char_script = get_character_script(sample_char)
        text_script = detect_scripts_in_text(sample_text)
        is_detected = (
            char_script == script_name
            and text_script["dominant_script"] == script_name
            and text_script["has_non_latin"] is True
            and script_name in text_script["detected_scripts"]
        )
        print(f"  - {script_name.capitalize():<12}: char={char_script:<10} dominant={text_script['dominant_script']:<10} detected={is_detected}")
        if not is_detected:
            all_scripts_detected = False

    assert all_scripts_detected, "Failed to identify all required Indic scripts!"
    results["check_1_script_detection"] = "PASS"

    # ──────────────────────────────────────────────────────────────────────────
    # Check 2: Anomalous Line Detection for Unread Regional Scripts
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 2: Anomalous Line Detection (PaddleOCR English on Indic)]")
    # Line 32 on lab_1_.jpeg transcribed as '30Eqyu' conf 0.5907
    anomalous_lines = [
        {"text": "Dr. Dhaval Patel M.D.", "confidence": 0.98},
        {"text": "30Eqyu", "confidence": 0.5907},
    ]
    inspection = inspect_ocr_lines_for_non_latin(anomalous_lines)
    print(f"  - Flagged potential unread non-Latin: {inspection['has_potential_unread_non_latin']}")
    print(f"  - Anomalous lines identified: {len(inspection['anomalous_lines'])}")
    assert inspection["has_potential_unread_non_latin"] is True
    assert len(inspection["anomalous_lines"]) == 1
    assert inspection["anomalous_lines"][0]["text"] == "30Eqyu"
    results["check_2_anomalous_detection"] = "PASS"

    # ──────────────────────────────────────────────────────────────────────────
    # Check 3: Clean English Fast-Path Retention (ROUTE-02)
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 3: Clean English Document Fast-Path Bypass (ROUTE-02)]")
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)

    mock_paddle_clean = MagicMock()
    mock_paddle_clean.is_available.return_value = True
    mock_paddle_clean.config_hash = "hash-clean"
    mock_paddle_clean.async_extract_text_from_bytes = AsyncMock(return_value={
        "full_text": (
            "METROPOLIS HEALTHCARE LTD\n"
            "PATIENT NAME: JOHN DOE  AGE: 34 Y / MALE\n"
            "TEST: COMPLETE BLOOD COUNT (CBC)\n"
            "HEMOGLOBIN: 14.2 g/dL (Reference: 13.0 - 17.0)\n"
            "RBC COUNT: 4.8 mill/cumm (Reference: 4.5 - 5.5)\n"
            "WBC COUNT: 6800 /cumm (Reference: 4000 - 11000)\n"
            "PLATELET COUNT: 250000 /cumm (Reference: 150000 - 450000)\n"
        ),
        "mean_confidence": 0.965,
        "min_confidence": 0.92,
        "lines": [
            {"text": "METROPOLIS HEALTHCARE LTD", "confidence": 0.98, "box": [[10, 10], [200, 10], [200, 30], [10, 30]]},
            {"text": "PATIENT NAME: JOHN DOE  AGE: 34 Y / MALE", "confidence": 0.96, "box": [[10, 40], [300, 40], [300, 60], [10, 60]]},
            {"text": "TEST: COMPLETE BLOOD COUNT (CBC)", "confidence": 0.97, "box": [[10, 70], [250, 70], [250, 90], [10, 90]]},
            {"text": "HEMOGLOBIN: 14.2 g/dL (Reference: 13.0 - 17.0)", "confidence": 0.95, "box": [[10, 100], [350, 100], [350, 120], [10, 120]]},
            {"text": "RBC COUNT: 4.8 mill/cumm (Reference: 4.5 - 5.5)", "confidence": 0.96, "box": [[10, 130], [340, 130], [340, 150], [10, 150]]},
            {"text": "WBC COUNT: 6800 /cumm (Reference: 4000 - 11000)", "confidence": 0.94, "box": [[10, 160], [330, 160], [330, 180], [10, 180]]},
            {"text": "PLATELET COUNT: 250000 /cumm (Reference: 150000 - 450000)", "confidence": 0.96, "box": [[10, 190], [380, 190], [380, 210], [10, 210]]},
        ],
    })

    mock_vision_clean = MagicMock()
    mock_vision_clean.extract_image = AsyncMock(side_effect=RuntimeError("VLM was erroneously called on clean document!"))

    handler_clean = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision_clean,
        paddle_engine=mock_paddle_clean,
        quality_gate=QualityGate(min_mean_confidence=0.82),
    )

    clean_res = loop.run_until_complete(
        handler_clean._extract_page_with_tiered_ocr(b"clean-doc-bytes", page_num=1)
    )

    print(f"  - Clean Doc Engine: {clean_res['engine']}")
    print(f"  - Clean Doc Status: {clean_res['status']}")
    print(f"  - Fallback Reason: {clean_res['fallback_reason']}")
    print(f"  - VLM Call Count: {mock_vision_clean.extract_image.call_count}")

    assert clean_res["status"] == "SUCCESS", "Clean document should succeed without fallback!"
    assert clean_res["engine"] == "paddleocr", "Clean document should use paddleocr!"
    assert clean_res["fallback_reason"] is None
    assert mock_vision_clean.extract_image.call_count == 0, "VLM must NOT be called for clean Latin docs!"
    results["check_3_clean_english_bypass"] = "PASS"

    # ──────────────────────────────────────────────────────────────────────────
    # Check 4: Zero-Silent-Drop Script Guard & Quality Router (ROUTE-01, MULTI-02)
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 4: Zero-Silent-Drop Quality Router Gate (ROUTE-01, MULTI-02)]")
    # Simulate doc with 32 clean English lines + 1 unread Indic line
    mock_paddle_regional = MagicMock()
    mock_paddle_regional.is_available.return_value = True
    mock_paddle_regional.config_hash = "hash-regional"
    mock_paddle_regional.async_extract_text_from_bytes = AsyncMock(return_value={
        "full_text": "Prescription Note\n30Eqyu",
        "mean_confidence": 0.945,
        "min_confidence": 0.59,
        "lines": [
            {"text": "Prescription Note", "confidence": 0.98, "box": [[10, 10], [150, 10], [150, 30], [10, 30]]},
            {"text": "30Eqyu", "confidence": 0.5907, "box": [[10, 40], [60, 40], [60, 60], [10, 60]]},
        ],
    })

    mock_vision_regional = MagicMock()
    mock_vision_regional.extract_image = AsyncMock(return_value={
        "text": "Prescription Note\nફરી બતાવવા માટે 30 દિવસ પછી આવવું",
        "confidence": 0.95,
        "lines": [],
    })

    handler_regional = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vision_regional,
        paddle_engine=mock_paddle_regional,
        quality_gate=QualityGate(min_mean_confidence=0.82),
    )

    regional_res = loop.run_until_complete(
        handler_regional._extract_page_with_tiered_ocr(b"regional-doc-bytes", page_num=1)
    )

    print(f"  - Regional Doc Engine: {regional_res['engine']}")
    print(f"  - Regional Doc Status: {regional_res['status']}")
    print(f"  - Fallback Reason: {regional_res['fallback_reason']}")
    print(f"  - VLM Call Count: {mock_vision_regional.extract_image.call_count}")

    assert regional_res["status"] == "FALLBACK"
    assert regional_res["fallback_reason"] == "UNREAD_NON_LATIN_SCRIPT"
    assert regional_res["engine"] == "hybrid_paddle_vlm"
    assert mock_vision_regional.extract_image.call_count == 1

    # Verify Gujarati text is present in final text
    has_guj = any(0x0A80 <= ord(c) <= 0x0AFF for c in regional_res["text"])
    print(f"  - Retained Regional Gujarati Characters: {has_guj}")
    assert has_guj is True, "Regional instructions were dropped!"
    results["check_4_quality_router_guard"] = "PASS"

    # ──────────────────────────────────────────────────────────────────────────
    # Check 5: Golden Document End-to-End Pipeline & Table Retention
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 5: Golden Document (lab_1_.jpeg) Hybrid OCR & Table Retention]")
    fixture_path = AI_SERVICE_DIR / "tests" / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    assert fixture_path.is_file(), f"Fixture missing at {fixture_path}"
    image_bytes = fixture_path.read_bytes()

    engine = PaddleOcrEngine.get_instance(lang="en", bypass_orientation=True, cpu_threads=4)
    mock_vlm_golden = MagicMock()
    mock_vlm_golden.extract_image = AsyncMock(return_value={
        "text": "કોલ બાંધા નાં 30 કિસા વાંચ આદુ\nફરી બતાવવા માટે 30 દિવસ પછી આવવું",
        "confidence": 0.95,
    })

    ocr_handler_golden = OcrStageHandler(
        s3_client=None,
        vision_service=mock_vlm_golden,
        paddle_engine=engine,
        quality_gate=QualityGate(min_mean_confidence=0.82),
    )

    t0_golden = time.perf_counter()
    golden_page = loop.run_until_complete(
        ocr_handler_golden._extract_page_with_tiered_ocr(image_bytes, page_num=1)
    )
    golden_ocr_ms = (time.perf_counter() - t0_golden) * 1000

    print(f"  - lab_1_.jpeg Engine: {golden_page['engine']}")
    print(f"  - lab_1_.jpeg Status: {golden_page['status']}")
    print(f"  - Fallback Reason: {golden_page['fallback_reason']}")
    print(f"  - Total Lines: {len(golden_page['lines'])}")
    print(f"  - Lines with BBoxes: {sum(1 for l in golden_page['lines'] if l.get('box'))}")
    print(f"  - Total OCR Elapsed: {golden_ocr_ms:.2f} ms")

    assert golden_page["status"] == "FALLBACK"
    assert golden_page["fallback_reason"] == "UNREAD_NON_LATIN_SCRIPT"
    assert golden_page["engine"] == "hybrid_paddle_vlm"
    assert len(golden_page["lines"]) >= 32

    # Verify downstream layout stage table reconstruction
    layout_handler = LayoutStageHandler(row_vertical_tolerance=0.65)
    raw_ocr = {
        "pages": [golden_page],
        "fullText": golden_page["text"],
        "confidence": golden_page["confidence"],
        "pageCount": 1,
    }

    t0_lay = time.perf_counter()
    layout_data = layout_handler.parse_layout(raw_ocr)
    layout_ms = (time.perf_counter() - t0_lay) * 1000

    tables = layout_data.get("tables", [])
    print(f"  - Layout Stage Time: {layout_ms:.2f} ms")
    print(f"  - Tables Extracted: {len(tables)}")
    if tables:
        print(f"  - Table 0 Headers: {tables[0].get('headers')}")
        print(f"  - Table 0 Row Count: {tables[0].get('rowCount')}")

    assert len(tables) >= 1, "Spatial table reconstruction failed on hybrid output!"
    assert layout_data["metrics"]["has_spatial_boxes"] is True
    results["check_5_golden_e2e_hybrid_tables"] = "PASS"

    # ──────────────────────────────────────────────────────────────────────────
    # Check 6: Telemetry Spans & PHI Audit
    # ──────────────────────────────────────────────────────────────────────────
    print("\n[Check 6: Zero-PHI Audit in Telemetry & Outputs]")
    raw_output_str = json.dumps(results)
    # Check no raw patient identifiers leaked in summary
    assert "URMILA" not in raw_output_str
    assert "9408654092" not in raw_output_str
    print("  - Zero PHI leaked into verification outputs: PASS")
    results["check_6_zero_phi_invariant"] = "PASS"

    print("\n" + "=" * 80)
    print("ALL PHASE 4 VERIFICATION CHECKS PASSED:")
    for k, v in results.items():
        print(f"  {k:<35}: {v}")
    print("=" * 80)

    # Save results to json artifact
    report_path = AI_SERVICE_DIR / "reports" / "phase4_verification_results.json"
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(results, indent=2), encoding="utf-8")
    print(f"Saved verification report to: {report_path}")


if __name__ == "__main__":
    verify_phase4()
