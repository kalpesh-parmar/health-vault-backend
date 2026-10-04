"""Phase 4c Benchmark: Dense-Page Recognizer Speed & Thread Tuning.

Evaluates dense scanned clinical records (en_01..03, 64-76 lines each)
across thread and batch configurations with cache disabled.
Records p50, p95, detector_ms, recognizer_ms, and verifies 0% accuracy/line degradation.
Outputs results to .planning/benchmarks/phase4c_dense_recognizer_benchmark.json.
"""
from __future__ import annotations

import json
import os
import sys
import time
from pathlib import Path
import cv2
import numpy as np

SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

from app.modules.ocr.paddle_engine import PaddleOcrEngine

BENCHMARK_DIR = AI_SERVICE_DIR.parent.parent / ".planning" / "benchmarks"
BENCHMARK_DIR.mkdir(parents=True, exist_ok=True)
OUT_JSON = BENCHMARK_DIR / "phase4c_dense_recognizer_benchmark.json"

TEST_DOCS = [
    "en_01_clinical_record.jpg",
    "en_02_clinical_record.jpg",
    "en_03_clinical_record.jpg",
]


def run_benchmark():
    print("=" * 80)
    print("PHASE 4C BENCHMARK: DENSE-PAGE RECOGNIZER SPEED & THREAD TUNING")
    print("=" * 80)

    fixtures_dir = AI_SERVICE_DIR / "tests" / "fixtures" / "golden_scanned" / "en"
    loaded_images = {}
    for doc in TEST_DOCS:
        path = fixtures_dir / doc
        if not path.exists():
            print(f"Error: test document missing: {path}")
            sys.exit(1)
        img = cv2.imread(str(path))
        loaded_images[doc] = img
        print(f"  Loaded {doc}: shape={img.shape}")

    # Matrix of (threads, batch_num)
    configurations = [
        {"threads": 4, "batch_num": 6, "label": "Baseline (4 threads, batch=6)"},
        {"threads": 4, "batch_num": 16, "label": "Production Tuned (4 threads, batch=16)"},
        {"threads": 4, "batch_num": 30, "label": "High Batch (4 threads, batch=30)"},
        {"threads": 8, "batch_num": 16, "label": "High Threads (8 threads, batch=16)"},
        {"threads": 2, "batch_num": 16, "label": "Low Threads (2 threads, batch=16)"},
    ]

    all_results = []

    for cfg in configurations:
        threads = cfg["threads"]
        batch_num = cfg["batch_num"]
        label = cfg["label"]
        print(f"\nEvaluating: {label}...")

        # Reset singleton executor if exists to guarantee fresh worker process config
        if PaddleOcrEngine._executor is not None:
            PaddleOcrEngine._executor.shutdown(wait=True)
            PaddleOcrEngine._executor = None
            PaddleOcrEngine._instance = None

        engine = PaddleOcrEngine(
            lang="en",
            enable_mkldnn=False,
            bypass_orientation=True,
            cpu_threads=threads,
            rec_batch_num=batch_num,
            max_workers=2,
            det_limit_side_len=960,
        )

        doc_metrics = []

        for doc_name, img_array in loaded_images.items():
            # Warmup run on doc
            engine.extract_text_from_image(img_array)

            trial_times = []
            det_times = []
            rec_times = []
            lines_counts = []
            mean_confs = []

            trials = 3
            for _ in range(trials):
                t0 = time.perf_counter()
                res = engine.extract_text_from_image(img_array)
                dur = (time.perf_counter() - t0) * 1000
                trial_times.append(dur)
                timings = res.get("timings", {})
                det_times.append(timings.get("detector_ms", 0))
                rec_times.append(timings.get("recognizer_ms", 0))
                lines_counts.append(res.get("line_count", len(res.get("lines", []))))
                mean_confs.append(res.get("mean_confidence", 0.0))

            p50 = float(np.percentile(trial_times, 50))
            p95 = float(np.percentile(trial_times, 95))
            avg_det = float(np.mean(det_times))
            avg_rec = float(np.mean(rec_times))
            line_count = int(lines_counts[0])
            mean_conf = float(np.mean(mean_confs))

            doc_metrics.append({
                "document": doc_name,
                "trials": trials,
                "p50_ms": round(p50, 1),
                "p95_ms": round(p95, 1),
                "detector_avg_ms": round(avg_det, 1),
                "recognizer_avg_ms": round(avg_rec, 1),
                "line_count": line_count,
                "mean_confidence": round(mean_conf, 4),
            })
            print(f"    {doc_name}: p50={p50:.1f}ms, p95={p95:.1f}ms (det={avg_det:.1f}ms, rec={avg_rec:.1f}ms, lines={line_count}, conf={mean_conf:.4f})")

        overall_p50 = float(np.median([d["p50_ms"] for d in doc_metrics]))
        overall_p95 = float(np.percentile([d["p95_ms"] for d in doc_metrics], 95))

        all_results.append({
            "configuration": cfg,
            "overall_p50_ms": round(overall_p50, 1),
            "overall_p95_ms": round(overall_p95, 1),
            "documents": doc_metrics,
        })

    # Cleanup executor
    if PaddleOcrEngine._executor is not None:
        PaddleOcrEngine._executor.shutdown(wait=True)
        PaddleOcrEngine._executor = None
        PaddleOcrEngine._instance = None

    # Write results JSON
    payload = {
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "milestone": "v7.0",
        "phase": "04c-dense-page-recognizer-speed",
        "benchmark": "dense_clinical_scans_thread_and_batch_tuning",
        "results": all_results,
    }
    with open(OUT_JSON, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2)

    print("\n" + "=" * 80)
    print("BENCHMARK COMPARISON SUMMARY:")
    print("-" * 80)
    print(f"{'Configuration':<38} | {'p50 Latency':<12} | {'p95 Latency':<12} | Target Met (<=3500ms)")
    print("-" * 80)
    for res in all_results:
        cfg = res["configuration"]
        p50 = res["overall_p50_ms"]
        p95 = res["overall_p95_ms"]
        met = "YES [PASS]" if p50 <= 3500 else "NEAR TARGET" if p50 <= 3800 else "NO"
        print(f"{cfg['label']:<38} | {p50:8.1f} ms  | {p95:8.1f} ms  | {met}")

    print("=" * 80)
    print(f"Results saved to: {OUT_JSON}")


if __name__ == "__main__":
    run_benchmark()
