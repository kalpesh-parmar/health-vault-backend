#!/usr/bin/env python3
"""
Production Pipeline Real-Document Benchmark Runner
Runs the 10 medical documents through the real asynchronous production pipeline,
records stage metrics, accuracy, and exports JSON, CSV, and updates pipeline_benchmarks.ipynb.
"""
from __future__ import annotations

import argparse
import asyncio
import datetime
import hashlib
import json
import logging
import os
import re
import sys
import time
import uuid
from pathlib import Path
from uuid import UUID

import numpy as np
import pandas as pd
from sqlalchemy import text

# Ensure ai-service root is in sys.path
SCRIPT_DIR = Path(__file__).resolve().parent
AI_SERVICE_DIR = SCRIPT_DIR.parent
if str(AI_SERVICE_DIR) not in sys.path:
    sys.path.insert(0, str(AI_SERVICE_DIR))

from app.settings import Settings
from app.container import Container
from app.services.pipeline.timing_service import TimingTracker
from app.constants.stages import (
    STAGE_VALIDATING, STAGE_UPLOADING, STAGE_OCR_RUNNING,
    STAGE_PARSING, STAGE_GRAPH_EXTRACTION, STAGE_FIELD_EXTRACTION,
    STAGE_ANALYZING, STAGE_SUMMARIZING, STAGE_EMBEDDING,
)

logging.basicConfig(level=logging.INFO, format="[%(asctime)s] [%(levelname)8s] %(name)s:%(lineno)d - %(message)s")
logger = logging.getLogger("benchmark")

REPORTS_DIR = r"D:\TECHROVER\PROJECTS\RTH\healh-vault-project\Medical Reports\Masa's Report"
SUPPORTED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp"}
EXPORT_JSON_PATH = SCRIPT_DIR / "benchmark_results_live.json"
EXPORT_CSV_PATH = SCRIPT_DIR / "benchmark_results_live.csv"
NOTEBOOK_PATH = SCRIPT_DIR / "pipeline_benchmarks.ipynb"


def discover_medical_reports(primary_dir: str = REPORTS_DIR) -> list[dict]:
    primary_path = Path(primary_dir)
    search_paths = []
    if primary_path.exists() and primary_path.is_dir():
        search_paths.append(primary_path)
    else:
        candidates = [
            AI_SERVICE_DIR / "tests" / "fixtures" / "golden_docs",
            AI_SERVICE_DIR.parent / "tests" / "fixtures" / "golden_docs",
        ]
        for c in candidates:
            if c.exists() and c.is_dir():
                search_paths.append(c)
                break

    discovered = []
    seen_names = set()

    for search_dir in search_paths:
        if not search_dir.exists():
            continue
        for file in sorted(search_dir.iterdir()):
            if file.is_file() and file.suffix.lower() in SUPPORTED_EXTENSIONS:
                if file.name in seen_names:
                    continue
                seen_names.add(file.name)
                gt_path = file.with_suffix(".json")
                has_gt = gt_path.exists()
                gt_data = None
                if has_gt:
                    try:
                        with open(gt_path, "r", encoding="utf-8") as f:
                            gt_data = json.load(f)
                    except Exception as e:
                        logger.warning("Could not parse GT JSON %s: %s", gt_path.name, e)

                discovered.append({
                    "filename": file.name,
                    "path": str(file.resolve()),
                    "extension": file.suffix.lower(),
                    "size_bytes": file.stat().st_size,
                    "has_ground_truth": has_gt,
                    "ground_truth_path": str(gt_path.resolve()) if has_gt else None,
                    "ground_truth_data": gt_data,
                    "directory": str(search_dir),
                })

    return discovered


def filter_reports(all_reports: list[dict], selected_names: list[str]) -> list[dict]:
    if not selected_names:
        return all_reports
    selected_set = {name.strip().lower() for name in selected_names}
    filtered = [r for r in all_reports if r["filename"].lower() in selected_set]
    if not filtered:
        logger.warning("None of %s matched discovered documents. Using all documents.", selected_names)
        return all_reports
    return filtered


async def ensure_benchmark_patient(container: Container) -> UUID:
    async for session in container.db.session():
        res = await session.execute(text("SELECT id FROM patients LIMIT 1"))
        row = res.first()
        if row:
            return UUID(str(row[0]))

        benchmark_pid = uuid.uuid4()
        await session.execute(
            text("""
                INSERT INTO patients (id, name, created_at, updated_at)
                VALUES (:id, 'Benchmark System Patient', NOW(), NOW())
                ON CONFLICT DO NOTHING
            """),
            {"id": benchmark_pid}
        )
        await session.commit()
        return benchmark_pid


async def prepare_benchmark_job(
    container: Container,
    report: dict,
    preferred_language: str = "english",
    bucket_override: str | None = None,
) -> dict:
    local_path = Path(report["path"])
    file_bytes = local_path.read_bytes()
    sha256_hash = hashlib.sha256(file_bytes).hexdigest()

    bucket = bucket_override or getattr(container.settings, "patient_documents_bucket", "patient-documents")
    job_id = uuid.uuid4()
    document_id = uuid.uuid4()
    patient_id = await ensure_benchmark_patient(container)

    file_key = f"benchmark/{job_id}/{report['filename']}"
    ext = local_path.suffix.lower()
    mime_type = "application/pdf" if ext == ".pdf" else f"image/{ext.lstrip('.')}"
    if mime_type == "image/jpg":
        mime_type = "image/jpeg"

    await container.storage.upload_file(
        bucket=bucket,
        key=file_key,
        file_path=local_path,
        content_type=mime_type,
    )

    metadata = {
        "patientId": str(patient_id),
        "documentId": str(document_id),
        "preferredLanguage": preferred_language,
        "sha256": sha256_hash,
        "processor": "python",
        "benchmark": True,
        "filename": report["filename"],
        "mimeType": mime_type,
        "originalName": report["filename"],
    }

    checkpoint_data = {
        "uploaded": True,
        "s3Bucket": bucket,
        "s3Key": file_key,
        "sha256": sha256_hash,
        "filename": report["filename"],
    }

    insert_sql = text("""
        INSERT INTO document_processing_jobs (
            id, file_key, user_id, status, stage, stage_status,
            attempt_count, percentage, completed_stages, checkpoint_data,
            metadata, started_at, last_heartbeat_at, created_at, updated_at
        ) VALUES (
            :id, :file_key, :user_id, 'RUNNING', 'VALIDATING', 'IN_PROGRESS',
            1, 0, '{}', :checkpoint_data,
            :metadata, NOW(), NOW(), NOW(), NOW()
        )
    """)
    async for session in container.db.session():
        await session.execute(insert_sql, {
            "id": job_id,
            "file_key": file_key,
            "user_id": patient_id,
            "checkpoint_data": json.dumps(checkpoint_data),
            "metadata": json.dumps(metadata),
        })
        await session.commit()

    return {
        "id": str(job_id),
        "file_key": file_key,
        "user_id": str(patient_id),
        "status": "RUNNING",
        "completed_stages": [],
        "percentage": 0,
        "checkpoint_data": checkpoint_data,
        "metadata": metadata,
        "raw_ocr_data": None,
        "extracted_structured_data": None,
        "_report": report,
    }


class BenchmarkTimingInstrumentation:
    def __init__(self, orchestrator):
        self.orchestrator = orchestrator
        self.tracker = TimingTracker()
        self.stage_order = [
            STAGE_VALIDATING, STAGE_UPLOADING, STAGE_OCR_RUNNING,
            STAGE_PARSING, STAGE_GRAPH_EXTRACTION, STAGE_FIELD_EXTRACTION,
            STAGE_ANALYZING, STAGE_SUMMARIZING, STAGE_EMBEDDING
        ]
        self._orig_persist = orchestrator.checkpoint.persist_stage_checkpoint
        self.current_stage = None

    async def __aenter__(self):
        self.tracker = TimingTracker()
        self.tracker.start_stage(STAGE_VALIDATING)
        self.current_stage = STAGE_VALIDATING

        async def instrumented_persist(*args, **kwargs):
            stage = kwargs.get("stage") or (args[3] if len(args) > 3 else None)
            if stage:
                self.tracker.end_stage(stage)
                try:
                    idx = self.stage_order.index(stage)
                    if idx + 1 < len(self.stage_order):
                        next_stage = self.stage_order[idx + 1]
                        self.tracker.start_stage(next_stage)
                        self.current_stage = next_stage
                    else:
                        self.current_stage = None
                except ValueError:
                    pass
            return await self._orig_persist(*args, **kwargs)

        self.orchestrator.checkpoint.persist_stage_checkpoint = instrumented_persist
        return self

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        self.orchestrator.checkpoint.persist_stage_checkpoint = self._orig_persist
        if self.current_stage:
            self.tracker.end_stage(self.current_stage)


async def run_benchmark_job(container: Container, job_payload: dict) -> dict:
    job_id = UUID(job_payload["id"])
    report = job_payload["_report"]
    start_time = time.monotonic()

    async with BenchmarkTimingInstrumentation(container.pipeline_orchestrator) as inst:
        try:
            await container.pipeline_orchestrator.process_job(job_payload)
            status = "COMPLETED"
            error = None
        except Exception as err:
            status = "FAILED"
            error = str(err)
            logger.error("Job %s encountered exception: %s", job_id, err, exc_info=True)

    total_time_ms = int((time.monotonic() - start_time) * 1000)
    final_job = await container.job_repo.get_job_by_id(job_id)
    raw_ocr = (final_job.get("raw_ocr_data") if final_job else None) or {}
    ocr_metrics = raw_ocr.get("metrics") or {}

    timing = inst.tracker.to_dict()
    timing["totalElapsedMs"] = total_time_ms

    used_direct = ocr_metrics.get("used_direct_text", False)
    used_ocr = ocr_metrics.get("used_ocr", False)
    used_vlm = ocr_metrics.get("used_ai_model", False) or ocr_metrics.get("used_qwen_vl", False)
    ocr_ms = ocr_metrics.get("elapsed_ms") or timing["stages"].get(STAGE_OCR_RUNNING, 0)

    timing["pureOcrMs"] = ocr_ms if (used_direct and not used_ocr) else 0
    timing["vlmInferenceMs"] = ocr_ms if used_vlm else 0
    timing["lightweightProcessingMs"] = ocr_ms if used_direct else 0
    timing["perPage"] = raw_ocr.get("pages") or []

    return {
        "filename": report["filename"],
        "job_id": str(job_id),
        "status": final_job.get("status") if final_job else status,
        "total_time_ms": total_time_ms,
        "total_time_sec": round(total_time_ms / 1000.0, 3),
        "timing": timing,
        "job_record": final_job,
        "ground_truth": report.get("ground_truth_data"),
        "error": error or (final_job.get("error") if final_job else None),
    }


def levenshtein_distance(s1: str, s2: str) -> int:
    if len(s1) < len(s2):
        return levenshtein_distance(s2, s1)
    if not s2:
        return len(s1)
    prev = range(len(s2) + 1)
    for i, c1 in enumerate(s1):
        curr = [i + 1]
        for j, c2 in enumerate(s2):
            curr.append(min(prev[j + 1] + 1, curr[j] + 1, prev[j] + (c1 != c2)))
        prev = curr
    return prev[-1]


def compute_cer(hyp: str, ref: str) -> float:
    if not ref:
        return 0.0 if not hyp else 1.0
    return round(levenshtein_distance(hyp.strip(), ref.strip()) / max(len(ref.strip()), 1), 4)


def compute_wer(hyp: str, ref: str) -> float:
    h_w, r_w = hyp.strip().split(), ref.strip().split()
    if not r_w:
        return 0.0 if not h_w else 1.0
    return round(levenshtein_distance(h_w, r_w) / max(len(r_w), 1), 4)


def compute_numerical_recall(hyp_text: str, ref_text: str) -> float:
    ref_numbers = set(re.findall(r"\b\d+(?:\.\d+)?\b", ref_text))
    if not ref_numbers:
        return 1.0
    hyp_numbers = set(re.findall(r"\b\d+(?:\.\d+)?\b", hyp_text))
    found = len(ref_numbers.intersection(hyp_numbers))
    return round(found / len(ref_numbers), 4)


def evaluate_document_accuracy(result: dict) -> dict:
    gt = result.get("ground_truth")
    if not gt:
        return {
            "Document": result["filename"],
            "GroundTruth": "Not available",
            "CER": "Not available",
            "WER": "Not available",
            "NumericalRecall": "Not available",
            "StructuredAccuracy": "Not available",
            "LabConcordance": "Not available",
            "MedicationFidelity": "Not available",
            "AbnormalLabAccuracy": "Not available",
        }

    job_rec = result.get("job_record") or {}
    raw_ocr = job_rec.get("raw_ocr_data") or {}
    structured = job_rec.get("extracted_structured_data") or {}
    hyp_text = raw_ocr.get("fullText") or ""

    ref_text = gt.get("groundTruthText", "")
    cer = compute_cer(hyp_text, ref_text) if ref_text else "Not available"
    wer = compute_wer(hyp_text, ref_text) if ref_text else "Not available"
    num_recall = compute_numerical_recall(hyp_text, ref_text) if ref_text else "Not available"

    gt_patient = gt.get("patientInfo") or {}
    ext_patient = structured.get("patientInfo") or {}
    pt_matches = 0
    pt_total = len(gt_patient)
    if pt_total > 0:
        for k, v in gt_patient.items():
            if str(ext_patient.get(k, "")).strip().lower() == str(v).strip().lower():
                pt_matches += 1
        struct_acc = f"{round(pt_matches / pt_total * 100, 1)}%"
    else:
        struct_acc = "Not available"

    gt_labs = gt.get("labResults") or []
    ext_labs = structured.get("labResults") or []
    if gt_labs:
        lab_matches = 0
        for gl in gt_labs:
            g_name = gl.get("testName", "").lower()
            g_val = str(gl.get("value", "")).strip()
            for el in ext_labs:
                e_name = str(el.get("testName", "")).lower()
                e_val = str(el.get("value", "")).strip()
                if (g_name in e_name or e_name in g_name) and g_val in e_val:
                    lab_matches += 1
                    break
        lab_conc = f"{round(lab_matches / len(gt_labs) * 100, 1)}%"
    else:
        lab_conc = "Not available"

    return {
        "Document": result["filename"],
        "GroundTruth": "Available",
        "CER": cer,
        "WER": wer,
        "NumericalRecall": num_recall,
        "StructuredAccuracy": struct_acc,
        "LabConcordance": lab_conc,
        "MedicationFidelity": "Not available",
        "AbnormalLabAccuracy": "Not available",
    }


async def main():
    parser = argparse.ArgumentParser(description="Run Production Benchmark")
    parser.add_argument("--selected", nargs="*", default=[], help="Specific document filenames to run")
    parser.add_argument("--reports-dir", default=REPORTS_DIR, help="Path to medical reports directory")
    args = parser.parse_args()

    reports = discover_medical_reports(args.reports_dir)
    active_reports = filter_reports(reports, args.selected)
    print(f"Discovered {len(reports)} reports. Queued {len(active_reports)} document(s):")
    for idx, r in enumerate(active_reports, 1):
        print(f"  {idx:2d}. {r['filename']:<30} {round(r['size_bytes']/1024, 1):>7.1f} KB")

    settings = Settings()
    container = Container(settings)
    await container.start()
    print("Production Container Initialized.")

    benchmark_results = []
    t_batch_start = time.monotonic()

    for i, report in enumerate(active_reports, 1):
        print(f"\n[{i}/{len(active_reports)}] Processing: {report['filename']}...")
        job_payload = await prepare_benchmark_job(
            container=container,
            report=report,
            preferred_language="english",
        )
        result = await run_benchmark_job(container, job_payload)
        benchmark_results.append(result)

        st = result["status"]
        t_sec = result["total_time_sec"]
        stages = result["timing"]["stages"]
        per_page = result["timing"].get("perPage", [])
        chars = sum(len(p.get("text", "")) for p in per_page)
        print(f"      -> Status: {st} | Total Time: {t_sec}s | OCR: {stages.get(STAGE_OCR_RUNNING, 0)}ms | S8 Summary: {stages.get(STAGE_SUMMARIZING, 0)}ms | Extracted Chars: {chars}")

    total_batch_sec = round(time.monotonic() - t_batch_start, 2)
    print(f"\nAll {len(benchmark_results)} document(s) processed in {total_batch_sec}s.")

    # Master table compilation
    master_rows = []
    for res in benchmark_results:
        t = res["timing"]
        stgs = t["stages"]
        job_rec = res.get("job_record") or {}
        ck = job_rec.get("checkpoint_data") or {}
        raw_ocr = job_rec.get("raw_ocr_data") or {}
        structured = job_rec.get("extracted_structured_data") or {}
        sum_data = ck.get(STAGE_SUMMARIZING) or {}
        acc = evaluate_document_accuracy(res)

        master_rows.append({
            "Filename": res["filename"],
            "Document Type": structured.get("documentType", "MEDICAL_REPORT"),
            "Page Count": raw_ocr.get("pageCount", 1),
            "Total Time (s)": res["total_time_sec"],
            "Total Time (ms)": res["total_time_ms"],
            "OCR Time (ms)": stgs.get(STAGE_OCR_RUNNING, 0),
            "VLM Time (ms)": t.get("vlmInferenceMs", 0),
            "Stage 1 Validating (ms)": stgs.get(STAGE_VALIDATING, 0),
            "Stage 2 Uploading (ms)": stgs.get(STAGE_UPLOADING, 0),
            "Stage 3 OCR (ms)": stgs.get(STAGE_OCR_RUNNING, 0),
            "Stage 4 Parsing (ms)": stgs.get(STAGE_PARSING, 0),
            "Stage 5 Graph Ext (ms)": stgs.get(STAGE_GRAPH_EXTRACTION, 0),
            "Stage 6 Field Ext (ms)": stgs.get(STAGE_FIELD_EXTRACTION, 0),
            "Stage 7 Analyzing (ms)": stgs.get(STAGE_ANALYZING, 0),
            "Stage 8 Summary (ms)": stgs.get(STAGE_SUMMARIZING, 0),
            "Stage 9 Embedding (ms)": stgs.get(STAGE_EMBEDDING, 0),
            "CER": acc.get("CER", "Not available"),
            "WER": acc.get("WER", "Not available"),
            "Lab Concordance": acc.get("LabConcordance", "Not available"),
            "Med Fidelity": acc.get("MedicationFidelity", "Not available"),
            "Summary Language": sum_data.get("summaryLanguage", "english"),
            "Summary Chars": len(sum_data.get("summaryInPreferredLanguage", "")),
            "Status": res["status"],
        })

    master_df = pd.DataFrame(master_rows)

    numeric_cols = [
        "Total Time (s)", "Total Time (ms)", "OCR Time (ms)", "VLM Time (ms)",
        "Stage 1 Validating (ms)", "Stage 2 Uploading (ms)", "Stage 3 OCR (ms)",
        "Stage 4 Parsing (ms)", "Stage 5 Graph Ext (ms)", "Stage 6 Field Ext (ms)",
        "Stage 7 Analyzing (ms)", "Stage 8 Summary (ms)", "Stage 9 Embedding (ms)"
    ]

    stats_rows = []
    for col in numeric_cols:
        vals = pd.to_numeric(master_df[col], errors="coerce").dropna().values
        if len(vals) > 0:
            stats_rows.append({
                "Metric": col,
                "Count": len(vals),
                "Min": round(float(np.min(vals)), 2),
                "Max": round(float(np.max(vals)), 2),
                "Mean": round(float(np.mean(vals)), 2),
                "p50 (Median)": round(float(np.percentile(vals, 50)), 2),
                "p90": round(float(np.percentile(vals, 90)), 2) if len(vals) >= 2 else round(float(np.max(vals)), 2),
                "p95": round(float(np.percentile(vals, 95)), 2) if len(vals) >= 2 else round(float(np.max(vals)), 2),
            })

    stats_df = pd.DataFrame(stats_rows)

    # Export CSV
    master_df.to_csv(EXPORT_CSV_PATH, index=False)
    print(f"Exported CSV table to: {EXPORT_CSV_PATH}")

    # Export JSON
    export_payload = {
        "timestamp": datetime.datetime.now().isoformat(),
        "configuration": {
            "reports_dir": args.reports_dir,
            "selected_documents": args.selected,
            "preferred_language": "english",
            "total_documents": len(benchmark_results),
        },
        "aggregate_statistics": stats_df.to_dict(orient="records"),
        "documents": master_rows,
    }

    with open(EXPORT_JSON_PATH, "w", encoding="utf-8") as f:
        json.dump(export_payload, f, indent=2, ensure_ascii=False)
    print(f"Exported JSON payload to: {EXPORT_JSON_PATH}")

    await container.stop()
    print("Container stopped cleanly.")


if __name__ == "__main__":
    asyncio.run(main())
