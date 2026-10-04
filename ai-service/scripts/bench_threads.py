import time
from pathlib import Path
import sys

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from app.modules.ocr.paddle_engine import PaddleOcrEngine

def run_bench():
    p = AI_SERVICE_DIR / "tests" / "fixtures" / "golden_docs" / "lab_1_.jpeg"
    b = p.read_bytes()

    for threads in [4, 8]:
        PaddleOcrEngine.reset_instance()
        e = PaddleOcrEngine.get_instance(lang="en", bypass_orientation=True, cpu_threads=threads)
        e.extract_text_from_bytes(b)  # warmup
        t0 = time.perf_counter()
        res = e.extract_text_from_bytes(b)
        ms = int((time.perf_counter() - t0) * 1000)
        total_ocr_ms = res["timings"]["total_ocr_ms"]
        det_ms = res["timings"]["detector_ms"]
        rec_ms = res["timings"]["recognizer_ms"]
        print(f"Threads={threads}: total_ocr_ms={total_ocr_ms}ms, det={det_ms}ms, rec={rec_ms}ms, wall={ms}ms, lines={res['line_count']}")

if __name__ == "__main__":
    run_bench()
