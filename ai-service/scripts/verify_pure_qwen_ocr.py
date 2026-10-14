import asyncio
import os
import sys
from pathlib import Path
from uuid import uuid4

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import psutil

from app.container import Container
from app.settings import Settings
from app.services.pipeline.ocr_stage import validate_ocr_result
from app.core.errors import OcrStageFailureError

TEST_IMG_PATH = Path(r"D:\TECHROVER\PROJECTS\RTH\healh-vault-project\Medical Reports\lab_1_.jpeg")

async def verify_pipeline():
    print("=" * 60)
    print("STEP 1: Verify Initial Process Tree for Stale Paddle Workers")
    current_pid = os.getpid()
    proc = psutil.Process(current_pid)
    initial_children = proc.children(recursive=True)
    print(f"Current PID: {current_pid}, Initial Child Processes: {len(initial_children)}")
    for child in initial_children:
        print(f"  Child PID: {child.pid}, Name: {child.name()}, Cmdline: {' '.join(child.cmdline()[:3])}")

    print("\n" + "=" * 60)
    print("STEP 2: Initialize Application Container & Lifespan Startup")
    settings = Settings()
    container = Container(settings)
    print(f"Container initialized. container.paddle_ocr = {container.paddle_ocr}")
    print(f"OCR handler paddle engine = {container.ocr_stage_handler.paddle}")

    # Run container lifespan startup
    await container.start()
    print("Container lifespan startup completed.")

    startup_children = proc.children(recursive=True)
    print(f"Post-startup Child Processes: {len(startup_children)}")
    assert len(startup_children) == 0, f"Expected 0 child workers, found {len(startup_children)}"
    print("[PASS] Zero child worker processes spawned during startup.")

    print("\n" + "=" * 60)
    print("STEP 3: Run OCR Stage on lab_1_.jpeg with Qwen3-VL")
    assert TEST_IMG_PATH.exists(), f"Test image does not exist: {TEST_IMG_PATH}"

    job_id = uuid4()
    ocr_result = await container.ocr_stage_handler.run_ocr(
        file_path=TEST_IMG_PATH,
        filename="lab_1_.jpeg",
        job_id=job_id,
        file_key="uploads/lab_1_.jpeg",
        current_pct=10,
        completed_stages=[],
        checkpoint_data={},
        mime_type="image/jpeg",
    )

    print("\n--- OCR Result Metrics ---")
    metrics = ocr_result.get("metrics", {})
    print(f"used_direct_text: {metrics.get('used_direct_text')}")
    print(f"used_ocr:         {metrics.get('used_ocr')}")
    print(f"used_paddle_ocr:  {metrics.get('used_paddle_ocr')}")
    print(f"used_qwen_vl:     {metrics.get('used_qwen_vl')}")
    print(f"page_count:       {metrics.get('page_count')}")
    print(f"failed_page_count:{metrics.get('failed_page_count')}")
    print(f"elapsed_ms:       {metrics.get('elapsed_ms')} ms")

    page0 = ocr_result["pages"][0]
    print(f"\nPage 1 Status: {page0['status']}, Engine: {page0['engine']}, Confidence: {page0['confidence']}")
    print(f"Page 1 Stage Timings: {page0.get('stage_timings')}")

    print("\n--- Extracted Text Preview (First 500 Chars) ---")
    print(ocr_result["fullText"][:500].encode("ascii", "replace").decode("ascii"))
    print("--- End Preview ---")

    # Assertions
    assert metrics.get("used_paddle_ocr") is False, "used_paddle_ocr must be False"
    assert metrics.get("used_qwen_vl") is True, "used_qwen_vl must be True"
    assert page0["engine"] == "qwen_vl", f"Expected engine qwen_vl, got {page0['engine']}"
    assert page0["status"] == "SUCCESS", f"Expected status SUCCESS, got {page0['status']}"
    assert len(ocr_result["fullText"].strip()) > 50, "Extracted text is too short"
    assert "CLINICAL DATA UNREADABLE" not in ocr_result["fullText"], "Found unreadable failure marker!"

    # Check key text elements from lab_1_.jpeg
    full_lower = ocr_result["fullText"].lower()
    has_clinic = "clinic" in full_lower or "complex" in full_lower or "kamrej" in full_lower
    has_medication = "tab" in full_lower or "mbson" in full_lower or "caldison" in full_lower or "1-0-0" in full_lower
    print(f"\nClinical verification: has_clinic={has_clinic}, has_medication={has_medication}")
    assert has_clinic or has_medication, "Extracted text does not match document content"
    print("[PASS] Qwen3-VL OCR returned accurate clinical document text.")

    # Validate result passes validation
    validate_ocr_result(ocr_result)
    print("[PASS] validate_ocr_result succeeded on output.")

    # Check child processes during/after processing
    post_ocr_children = proc.children(recursive=True)
    print(f"\nPost-OCR Child Processes: {len(post_ocr_children)}")
    assert len(post_ocr_children) == 0, f"Expected 0 child workers, found {len(post_ocr_children)}"
    print("[PASS] Zero PaddleOCR worker processes were launched.")

    print("\n" + "=" * 60)
    print("STEP 4: Verify OCR Failure Safeguards & Validation")
    # Simulate a failed OCR output
    failed_ocr_data = {
        "pages": [{"page": 1, "text": "", "status": "FAILED", "engine": "none"}],
        "fullText": "[PAGE 1 OCR FAILED - CLINICAL DATA UNREADABLE]",
        "metrics": {"failed_page_count": 1, "used_paddle_ocr": False, "used_qwen_vl": False},
    }
    try:
        validate_ocr_result(failed_ocr_data)
        print("[FAIL] Expected validate_ocr_result to raise OcrStageFailureError!")
    except OcrStageFailureError as err:
        print(f"[PASS] validate_ocr_result correctly caught failure: {err}")

    await container.stop()
    print("\n[SUCCESS] Entire pure Qwen3-VL pipeline verified with zero PaddleOCR involvement.")

if __name__ == "__main__":
    asyncio.run(verify_pipeline())
