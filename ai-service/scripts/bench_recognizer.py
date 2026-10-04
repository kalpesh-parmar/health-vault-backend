"""Benchmark dense page recognition speed across threads and batch sizes."""
import time
from pathlib import Path
import numpy as np
from PIL import Image
import cv2
from paddleocr import PaddleOCR

IMG_PATH = Path("tests/fixtures/golden_scanned/en/en_01_clinical_record.jpg")
print(f"Loading test scan: {IMG_PATH} (exists: {IMG_PATH.exists()})")

img = cv2.imread(str(IMG_PATH))
print(f"Image shape: {img.shape}")

# Test combinations: (threads, batch_num)
configs = [
    (4, 6),   # Default baseline
    (4, 16),
    (4, 30),
    (8, 6),
    (8, 16),
    (8, 30),
    (2, 16),
]

for threads, batch_num in configs:
    ocr = PaddleOCR(
        lang="en",
        use_angle_cls=False,
        show_log=False,
        enable_mkldnn=False,
        cpu_threads=threads,
        rec_batch_num=batch_num,
        det_limit_side_len=960,
    )
    # Warmup
    dummy = np.zeros((32, 32, 3), dtype=np.uint8)
    ocr.ocr(dummy, cls=False)

    # Benchmark 2 runs
    times = []
    line_counts = []
    for _ in range(2):
        t0 = time.perf_counter()
        res = ocr.ocr(img, cls=False)
        dur = (time.perf_counter() - t0) * 1000
        times.append(dur)
        lines = res[0] if (res and len(res) > 0 and res[0]) else []
        line_counts.append(len(lines))

    avg_ms = sum(times) / len(times)
    min_ms = min(times)
    print(f"Threads={threads:2d}, Batch={batch_num:2d} -> min={min_ms:.1f}ms, avg={avg_ms:.1f}ms, lines={line_counts[0]}")
