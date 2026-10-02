"""Production OCR Pipeline Benchmark Script

Measures exact wall time and per-stage latency (p50 / p95) across 3 consecutive runs
on test fixtures without caching, producing before/after audit tables.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
import platform
import statistics
import sys
import time
from pathlib import Path
from uuid import uuid4

# Ensure app is discoverable on python path
AI_SERVICE_DIR = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(AI_SERVICE_DIR))

from app.modules.ocr.paddle_engine import PaddleOcrEngine
from app.modules.ocr.quality_gate import QualityGate
from app.modules.vision.vision_service import VisionModelService
from app.services.pipeline.ocr_stage import OcrStageHandler
from app.settings import Settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    datefmt="%H:%M:%S",
)
logger = logging.getLogger("ocr_benchmark")


def calculate_percentiles(values: list[float]) -> dict[str, float]:
    """Calculate min, max, mean, p50, and p95 from a float series."""
    if not values:
        return {"min": 0.0, "max": 0.0, "mean": 0.0, "p50": 0.0, "p95": 0.0}
    sorted_vals = sorted(values)
    n = len(sorted_vals)
    p50_idx = int(0.50 * (n - 1))
    p95_idx = int(0.95 * (n - 1))
    return {
        "min": round(min(values), 2),
        "max": round(max(values), 2),
        "mean": round(statistics.mean(values), 2),
        "p50": round(sorted_vals[p50_idx], 2),
        "p95": round(sorted_vals[p95_idx], 2),
    }


def print_stage_table(stage_stats: dict[str, dict[str, float]], total_wall_stats: dict[str, float]) -> str:
    """Format stage timings into a Markdown table."""
    headers = ["Stage / Operation", "p50 (ms)", "p95 (ms)", "Mean (ms)", "Min (ms)", "Max (ms)"]
    rows = []
    
    stage_labels = [
        ("render_ms", "PDF Page Rendering"),
        ("queue_wait_ms", "Concurrency Queue / Lock Wait"),
        ("preprocess_ms", "Image Preprocessing"),
        ("lang_detect_ms", "Script / Lang Detection"),
        ("engine_init_ms", "Engine Init / Worker Check"),
        ("det_ms", "Paddle Text Detection (det)"),
        ("rec_ms", "Paddle Text Recognition (rec)"),
        ("ocr_infer_ms", "Paddle Total Inference"),
        ("quality_gate_ms", "QualityGate Evaluation"),
        ("vlm_call_ms", "Qwen-VL Vision Fallback"),
        ("postprocess_ms", "Postprocessing / Assembly"),
        ("total_page_ms", "Page Total Elapsed"),
    ]

    for key, label in stage_labels:
        stats = stage_stats.get(key, {"min": 0.0, "max": 0.0, "mean": 0.0, "p50": 0.0, "p95": 0.0})
        rows.append([
            label,
            f"{stats['p50']:.1f}",
            f"{stats['p95']:.1f}",
            f"{stats['mean']:.1f}",
            f"{stats['min']:.1f}",
            f"{stats['max']:.1f}",
        ])

    rows.append([
        "**TOTAL DOCUMENT WALL TIME**",
        f"**{total_wall_stats['p50']:.1f}**",
        f"**{total_wall_stats['p95']:.1f}**",
        f"**{total_wall_stats['mean']:.1f}**",
        f"**{total_wall_stats['min']:.1f}**",
        f"**{total_wall_stats['max']:.1f}**",
    ])

    col_widths = [max(len(str(item)) for item in col) for col in zip(headers, *rows)]
    
    lines = []
    header_line = "| " + " | ".join(h.ljust(w) for h, w in zip(headers, col_widths)) + " |"
    sep_line = "|-" + "-|-".join("-" * w for w in col_widths) + "-|"
    lines.append(header_line)
    lines.append(sep_line)
    for r in rows:
        row_line = "| " + " | ".join(str(cell).ljust(w) for cell, w in zip(r, col_widths)) + " |"
        lines.append(row_line)

    return "\n".join(lines)


async def main():
    try:
        sys.stdout.reconfigure(line_buffering=True)
    except Exception:
        pass
    parser = argparse.ArgumentParser(description="OCR Pipeline Benchmark Harness")
    parser.add_argument(
        "--file",
        type=Path,
        default=AI_SERVICE_DIR / "tests" / "fixtures" / "anonymized" / "anonymized_4page_hybrid.pdf",
        help="Path to fixture PDF document to benchmark",
    )
    parser.add_argument("--runs", type=int, default=3, help="Number of benchmark repetitions")
    parser.add_argument("--warmup", action="store_true", help="Execute 1 warmup run before measurement")
    parser.add_argument("--out", type=Path, default=AI_SERVICE_DIR / "scripts" / "benchmark_ocr_results.json", help="Path to save json results")
    args = parser.parse_args()

    if not args.file.exists():
        logger.error("Benchmark file does not exist: %s", args.file)
        sys.exit(1)

    settings = Settings()
    logger.info("Initializing benchmark harness...")
    logger.info("Target File: %s (%.2f MB)", args.file.name, args.file.stat().st_size / (1024 * 1024))
    logger.info("Platform: %s %s (Python %s)", platform.system(), platform.release(), platform.python_version())
    logger.info("CPU Cores: %s | AI Base URL: %s | Model: %s", os.cpu_count(), settings.ai_base_url, settings.ai_model)

    paddle_engine = PaddleOcrEngine.get_instance(
        enable_mkldnn=settings.paddle_enable_mkldnn,
        bypass_orientation=settings.paddle_bypass_orientation,
        cpu_threads=settings.paddle_cpu_threads,
    )
    quality_gate = QualityGate()
    vision_service = VisionModelService(
        api_key=settings.ai_api_key or "",
        base_url=settings.ai_base_url,
        model=settings.ai_model,
        timeout_seconds=settings.ai_timeout_seconds,
        max_retries=settings.ai_max_retries,
        max_output_tokens=settings.ai_max_output_tokens,
        min_text_chars=settings.ai_min_text_chars,
        cache_size=settings.ai_cache_size,
        max_inline_bytes=settings.ai_max_inline_bytes,
        page_concurrency=settings.ai_page_concurrency,
        max_image_side=getattr(settings, "vlm_max_image_side", 1500),
        num_ctx=getattr(settings, "vlm_num_ctx", 4096),
        num_predict=getattr(settings, "vlm_num_predict", 1536),
    )

    dummy_s3 = type("DummyS3", (), {"download_file": lambda *a, **k: None})()
    
    # We bypass the cache so every run executes real OCR & VLM inference
    handler = OcrStageHandler(
        s3_client=dummy_s3,
        lifecycle=None,
        vision_service=vision_service,
        paddle_engine=paddle_engine,
        quality_gate=quality_gate,
        min_direct_text_chars=settings.ai_min_text_chars,
        cache=None,
    )

    if args.warmup:
        logger.info("Executing warmup pass...")
        await handler.run_ocr(
            file_path=args.file,
            filename=args.file.name,
            job_id=uuid4(),
            file_key=args.file.name,
            current_pct=15,
            completed_stages=[],
            checkpoint_data={},
        )
        logger.info("Warmup complete.")

    run_wall_times_ms: list[float] = []
    run_records: list[dict] = []
    all_page_timings: dict[str, list[float]] = {
        "queue_wait_ms": [],
        "render_ms": [],
        "preprocess_ms": [],
        "lang_detect_ms": [],
        "engine_init_ms": [],
        "det_ms": [],
        "rec_ms": [],
        "ocr_infer_ms": [],
        "quality_gate_ms": [],
        "vlm_call_ms": [],
        "postprocess_ms": [],
        "total_page_ms": [],
    }

    logger.info("Starting %d benchmark runs on %s...", args.runs, args.file.name)

    for run_idx in range(1, args.runs + 1):
        logger.info("=== Run %d / %d ===", run_idx, args.runs)
        t_wall_start = time.perf_counter()
        
        result = await handler.run_ocr(
            file_path=args.file,
            filename=args.file.name,
            job_id=uuid4(),
            file_key=args.file.name,
            current_pct=15,
            completed_stages=[],
            checkpoint_data={},
        )
        
        wall_ms = round((time.perf_counter() - t_wall_start) * 1000, 2)
        run_wall_times_ms.append(wall_ms)
        pages = result.get("pages", [])
        logger.info("Run %d finished in %.2f s (pages=%d, confidence=%.4f)", run_idx, wall_ms / 1000, len(pages), result.get("confidence", 0.0))

        run_record = {
            "run": run_idx,
            "wall_ms": wall_ms,
            "page_count": len(pages),
            "confidence": result.get("confidence", 0.0),
            "metrics": result.get("metrics", {}),
            "pages": [],
        }

        for p in pages:
            page_num = p.get("page")
            st = p.get("stage_timings", {})
            for k in all_page_timings:
                all_page_timings[k].append(float(st.get(k, 0.0)))

            run_record["pages"].append({
                "page": page_num,
                "engine": p.get("engine"),
                "status": p.get("status"),
                "confidence": p.get("confidence"),
                "chars": len((p.get("text") or "").strip()),
                "elapsed_ms": p.get("elapsed_ms", 0),
                "fallback_reason": p.get("fallback_reason"),
                "stage_timings": st,
            })
            logger.info(
                "  Page %d: engine=%s, status=%s, conf=%.3f, chars=%d, total=%.1fms (det=%.1f, rec=%.1f, vlm=%.1f, wait=%.1f)",
                page_num,
                p.get("engine"),
                p.get("status"),
                float(p.get("confidence") or 0.0),
                len((p.get("text") or "").strip()),
                float(st.get("total_page_ms", 0.0)),
                float(st.get("det_ms", 0.0)),
                float(st.get("rec_ms", 0.0)),
                float(st.get("vlm_call_ms", 0.0)),
                float(st.get("queue_wait_ms", 0.0)),
            )

        run_records.append(run_record)

    total_wall_stats = calculate_percentiles(run_wall_times_ms)
    stage_stats = {k: calculate_percentiles(v) for k, v in all_page_timings.items()}

    table_md = print_stage_table(stage_stats, total_wall_stats)

    print("\n" + "=" * 80)
    print(f"BENCHMARK RESULTS: {args.file.name} ({args.runs} runs)")
    print("=" * 80)
    print(table_md)
    print("=" * 80)

    summary_payload = {
        "file": str(args.file),
        "file_name": args.file.name,
        "runs": args.runs,
        "run_wall_times_ms": run_wall_times_ms,
        "total_wall_stats": total_wall_stats,
        "stage_stats": stage_stats,
        "records": run_records,
    }

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(summary_payload, indent=2), encoding="utf-8")
    logger.info("Saved benchmark output to %s", args.out)


if __name__ == "__main__":
    asyncio.run(main())
