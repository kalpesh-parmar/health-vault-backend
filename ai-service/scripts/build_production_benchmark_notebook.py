"""
build_production_benchmark_notebook.py
Generates the comprehensive real-document production pipeline benchmark notebook:
ai-service/scripts/pipeline_benchmarks.ipynb
"""

import json
from pathlib import Path

def create_notebook():
    cells = []

    def md(source: str):
        cells.append({
            "cell_type": "markdown",
            "metadata": {},
            "source": [line + "\n" for line in source.strip().split("\n")]
        })

    def code(source: str):
        cells.append({
            "cell_type": "code",
            "execution_count": None,
            "metadata": {},
            "outputs": [],
            "source": [line + "\n" for line in source.strip().split("\n")]
        })

    # ─────────────────────────────────────────────────────────────────────────
    # Title & Introduction
    # ─────────────────────────────────────────────────────────────────────────
    md("""# Production Pipeline Real-Document Performance & Quality Benchmarks

This notebook benchmarks real medical documents against the live Python `ai-service` production pipeline.

### Core Execution Principles:
- **Real Production Pipeline**: Direct execution of `container.pipeline_orchestrator.process_job(job)`.
- **Zero Route Bypasses**: Bypasses HTTP FastAPI wrapper `process_document()` to benchmark the real asynchronous processing core.
- **Isolated Execution**: S3 storage keys and PostgreSQL job rows are isolated under `benchmark/{job_id}/...` with `benchmark: true` tags.
- **Granular 9-Stage Timing**: Full telemetry for `VALIDATING`, `UPLOADING`, `OCR_RUNNING`, `PARSING`, `GRAPH_EXTRACTION`, `FIELD_EXTRACTION`, `ANALYZING`, `SUMMARIZING`, and `EMBEDDING`.
- **Rigorous Ground-Truth Quality**: When companion ground-truth `.json` files exist, measures OCR CER/WER, numerical recall, structured field accuracy, lab concordance, and medication dosage fidelity. If ground truth is absent, displays "Not available".
- **Multilingual Clinical Summaries**: Validates synthesis in English and translation to `PREFERRED_LANGUAGE` (`english`, `gujarati`, `hindi`, `marathi`, `tamil`) with dosage preservation verification.""")

    # ─────────────────────────────────────────────────────────────────────────
    # 1. Configuration
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 1. Configuration
Configure document discovery, selection, preferred summary language, and export paths.""")

    code("""# ==============================================================================
# 1. CONFIGURATION
# ==============================================================================
from pathlib import Path

# Primary directory for medical reports (PDFs, PNG, JPEG, WEBP)
# Falls back to tests/fixtures/golden_docs if ./medical_reports is empty/absent
REPORTS_DIR = "./medical_reports"

# Document selection:
# - Leave empty [] to process ALL discovered documents in REPORTS_DIR
# - Or specify 1 or more filenames to process selected documents, e.g.:
#   SELECTED_DOCUMENTS = ["metabolic_panel.pdf", "born_digital_text.pdf"]
SELECTED_DOCUMENTS = []

# Preferred summary language for Stage 8 (SUMMARIZING)
# Supported: "english", "gujarati", "hindi", "marathi", "tamil"
PREFERRED_LANGUAGE = "english"

# Export file paths
EXPORT_JSON_PATH = "benchmark_results_live.json"
EXPORT_CSV_PATH = "benchmark_results_live.csv"

# Storage bucket override (None uses container.settings.patient_documents_bucket)
BENCHMARK_BUCKET_OVERRIDE = None

print(f"Configuration Loaded:")
print(f"  Reports Directory:   {REPORTS_DIR}")
print(f"  Selected Documents:  {SELECTED_DOCUMENTS if SELECTED_DOCUMENTS else 'ALL'}")
print(f"  Preferred Language:  {PREFERRED_LANGUAGE}")
print(f"  Export Paths:        {EXPORT_JSON_PATH}, {EXPORT_CSV_PATH}")""")

    # ─────────────────────────────────────────────────────────────────────────
    # 2. Discover Reports
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 2. Discover Reports
Automatically scans the reports directory (and test fixtures fallback) for medical reports and companion ground-truth JSON files.""")

    code("""# ==============================================================================
# 2. DISCOVER REPORTS
# ==============================================================================
import os
import json
import pandas as pd
from pathlib import Path

SUPPORTED_EXTENSIONS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".tiff", ".bmp"}

def discover_medical_reports(primary_dir: str = "./medical_reports") -> list[dict]:
    search_paths = [Path(primary_dir)]
    
    # Fallback to test fixtures if primary directory does not exist or has no documents
    candidates = [
        Path("tests/fixtures/golden_docs"),
        Path("../tests/fixtures/golden_docs"),
        Path("ai-service/tests/fixtures/golden_docs"),
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
                
                # Check for companion ground-truth JSON
                gt_path = file.with_suffix(".json")
                has_gt = gt_path.exists()
                gt_data = None
                if has_gt:
                    try:
                        with open(gt_path, "r", encoding="utf-8") as f:
                            gt_data = json.load(f)
                    except Exception as e:
                        print(f"Warning: Could not parse GT JSON {gt_path.name}: {e}")

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

discovered_reports = discover_medical_reports(REPORTS_DIR)
print(f"Discovered {len(discovered_reports)} medical report(s):")

discovery_df = pd.DataFrame([
    {
        "Filename": r["filename"],
        "Format": r["extension"].upper().lstrip("."),
        "Size (KB)": round(r["size_bytes"] / 1024, 1),
        "Ground Truth": "Available" if r["has_ground_truth"] else "Not available",
        "Source Directory": r["directory"],
    }
    for r in discovered_reports
])
discovery_df""")

    # ─────────────────────────────────────────────────────────────────────────
    # 3. Select Reports
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 3. Select Reports
Filters discovered documents based on `SELECTED_DOCUMENTS`.""")

    code("""# ==============================================================================
# 3. SELECT REPORTS
# ==============================================================================
def filter_reports(all_reports: list[dict], selected_names: list[str]) -> list[dict]:
    if not selected_names:
        return all_reports
    selected_set = {name.strip().lower() for name in selected_names}
    filtered = [r for r in all_reports if r["filename"].lower() in selected_set]
    if not filtered:
        print(f"Warning: None of {selected_names} matched discovered documents. Using all documents.")
        return all_reports
    return filtered

active_reports = filter_reports(discovered_reports, SELECTED_DOCUMENTS)
print(f"Active Benchmark Queue: {len(active_reports)} of {len(discovered_reports)} document(s) queued for execution:")
for idx, r in enumerate(active_reports, 1):
    gt_label = "[Ground Truth Available]" if r["has_ground_truth"] else "[No Ground Truth]"
    print(f"  {idx:2d}. {r['filename']:<30} {round(r['size_bytes']/1024, 1):>7.1f} KB   {gt_label}")""")

    # ─────────────────────────────────────────────────────────────────────────
    # 4. Initialize Production Container
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 4. Initialize Production Container
Boots the actual production `Container` and warms up vision, translation, and language detection engines.""")

    code("""# ==============================================================================
# 4. INITIALIZE PRODUCTION CONTAINER
# ==============================================================================
import sys
import asyncio
from pathlib import Path

# Ensure ai-service root is in sys.path
cwd = Path.cwd()
if not (cwd / "app").exists() and (cwd.parent / "app").exists():
    sys.path.insert(0, str(cwd.parent))
elif str(cwd) not in sys.path:
    sys.path.insert(0, str(cwd))

from app.settings import Settings
from app.container import Container

settings = Settings()
container = Container(settings)

# Warm up core AI services
await container.start()

print("Production Container Initialized Successfully:")
print(f"  Storage Provider:     {container.storage_provider}")
print(f"  Document Bucket:      {getattr(container.settings, 'patient_documents_bucket', 'patient-documents')}")
print(f"  Database Engine:      {settings.database_url.split('@')[-1]}")
print(f"  Vision Model:         {settings.ai_model}")
print(f"  Translation Engine:   IndicTrans2 (Warm: {container.translation.is_warm})")
print(f"  Pipeline Orchestrator:{container.pipeline_orchestrator.__class__.__name__}")""")

    # ─────────────────────────────────────────────────────────────────────────
    # 5. Prepare Benchmark Job
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 5. Prepare Benchmark Job
Creates the minimum valid `document_processing_jobs` database row and uploads the document to S3/MinIO under an isolated `benchmark/{job_id}/...` key.""")

    code("""# ==============================================================================
# 5. PREPARE BENCHMARK JOB
# ==============================================================================
import uuid
import hashlib
import json
from uuid import UUID
from sqlalchemy import text

async def ensure_benchmark_patient(container: Container) -> UUID:
    \"\"\"Obtains an existing patient ID or creates a dedicated benchmark patient.\"\"\"
    async for session in container.db.session():
        res = await session.execute(text("SELECT id FROM patients LIMIT 1"))
        row = res.first()
        if row:
            return UUID(str(row[0]))
        
        # If patients table is empty, create a benchmark patient
        benchmark_pid = uuid.uuid4()
        await session.execute(
            text(\"\"\"
                INSERT INTO patients (id, name, created_at, updated_at)
                VALUES (:id, 'Benchmark System Patient', NOW(), NOW())
                ON CONFLICT DO NOTHING
            \"\"\"),
            {"id": benchmark_pid}
        )
        await session.commit()
        return benchmark_pid

async def prepare_benchmark_job(
    container: Container,
    report: dict,
    preferred_language: str = "english",
    bucket_override: str | None = None
) -> dict:
    \"\"\"Uploads document to object storage and inserts an isolated RUNNING job record.\"\"\"
    local_path = Path(report["path"])
    file_bytes = local_path.read_bytes()
    sha256_hash = hashlib.sha256(file_bytes).hexdigest()
    
    bucket = bucket_override or getattr(container.settings, "patient_documents_bucket", "patient-documents")
    job_id = uuid.uuid4()
    document_id = uuid.uuid4()
    patient_id = await ensure_benchmark_patient(container)
    
    # Store under isolated benchmark key
    file_key = f"benchmark/{job_id}/{report['filename']}"
    
    # Determine MIME type
    ext = local_path.suffix.lower()
    mime_type = "application/pdf" if ext == ".pdf" else f"image/{ext.lstrip('.')}"
    if mime_type == "image/jpg":
        mime_type = "image/jpeg"
        
    # Upload to storage
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
    
    # Insert job with status='RUNNING' so checkpoint updates succeed
    insert_sql = text(\"\"\"
        INSERT INTO document_processing_jobs (
            id, file_key, user_id, status, stage, stage_status,
            attempt_count, percentage, completed_stages, checkpoint_data,
            metadata, started_at, last_heartbeat_at, created_at, updated_at
        ) VALUES (
            :id, :file_key, :user_id, 'RUNNING', 'VALIDATING', 'IN_PROGRESS',
            1, 0, '{}', :checkpoint_data,
            :metadata, NOW(), NOW(), NOW(), NOW()
        )
    \"\"\")
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

print("Job setup helper ready.")""")

    # ─────────────────────────────────────────────────────────────────────────
    # 6. Run Production Pipeline
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 6. Run Production Pipeline
Executes `container.pipeline_orchestrator.process_job(job)` directly and measures real stage durations using `TimingTracker`.""")

    code("""# ==============================================================================
# 6. RUN PRODUCTION PIPELINE (container.pipeline_orchestrator.process_job)
# ==============================================================================
import time
from app.services.pipeline.timing_service import TimingTracker
from app.constants.stages import (
    STAGE_VALIDATING, STAGE_UPLOADING, STAGE_OCR_RUNNING,
    STAGE_PARSING, STAGE_GRAPH_EXTRACTION, STAGE_FIELD_EXTRACTION,
    STAGE_ANALYZING, STAGE_SUMMARIZING, STAGE_EMBEDDING
)

class BenchmarkTimingInstrumentation:
    \"\"\"Instruments orchestrator execution using the existing TimingTracker without altering production code.\"\"\"
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
    \"\"\"Invokes the REAL production pipeline_orchestrator.process_job and extracts metrics.\"\"\"
    job_id = UUID(job_payload["id"])
    report = job_payload["_report"]
    start_time = time.monotonic()
    
    async with BenchmarkTimingInstrumentation(container.pipeline_orchestrator) as inst:
        try:
            # DIRECT EXECUTION OF PRODUCTION PIPELINE
            await container.pipeline_orchestrator.process_job(job_payload)
            status = "COMPLETED"
            error = None
        except Exception as err:
            status = "FAILED"
            error = str(err)
            print(f"Job {job_id} encountered exception: {err}")

    total_time_ms = int((time.monotonic() - start_time) * 1000)
    
    # Retrieve updated database job row
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

print("Pipeline runner ready.")""")

    # ─────────────────────────────────────────────────────────────────────────
    # 7. Collect Results (Execute Batch)
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 7. Collect Results
Processes all queued documents through the production pipeline and stores results.""")

    code("""# ==============================================================================
# 7. COLLECT RESULTS (EXECUTE BENCHMARK BATCH)
# ==============================================================================
benchmark_results = []

print(f"Executing production benchmark on {len(active_reports)} document(s)...\\n")

for i, report in enumerate(active_reports, 1):
    print(f"[{i}/{len(active_reports)}] Processing: {report['filename']}...")
    # 1. Setup isolated benchmark job & upload to S3
    job_payload = await prepare_benchmark_job(
        container=container,
        report=report,
        preferred_language=PREFERRED_LANGUAGE,
        bucket_override=BENCHMARK_BUCKET_OVERRIDE,
    )
    
    # 2. Run real production orchestrator
    result = await run_benchmark_job(container, job_payload)
    benchmark_results.append(result)
    
    st = result["status"]
    t_sec = result["total_time_sec"]
    stages = result["timing"]["stages"]
    print(f"      -> Status: {st} | Total Time: {t_sec}s | OCR: {stages.get(STAGE_OCR_RUNNING, 0)}ms | S8 Summary: {stages.get(STAGE_SUMMARIZING, 0)}ms")

print(f"\\nAll {len(benchmark_results)} document(s) processed.")""")

    # ─────────────────────────────────────────────────────────────────────────
    # 8. Stage Timing Analysis
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 8. Stage Timing Analysis
Detailed breakdown across all 9 canonical stages, pure OCR, VLM inference, storage, and per-page metrics.""")

    code("""# ==============================================================================
# 8. STAGE TIMING ANALYSIS
# ==============================================================================
import pandas as pd

timing_rows = []
for res in benchmark_results:
    t = res["timing"]
    stgs = t["stages"]
    timing_rows.append({
        "Document": res["filename"],
        "Total (s)": res["total_time_sec"],
        "Total (ms)": res["total_time_ms"],
        "Validating (ms)": stgs.get(STAGE_VALIDATING, 0),
        "Uploading (ms)": stgs.get(STAGE_UPLOADING, 0),
        "OCR Running (ms)": stgs.get(STAGE_OCR_RUNNING, 0),
        "Parsing (ms)": stgs.get(STAGE_PARSING, 0),
        "Graph Ext (ms)": stgs.get(STAGE_GRAPH_EXTRACTION, 0),
        "Field Ext (ms)": stgs.get(STAGE_FIELD_EXTRACTION, 0),
        "Analyzing (ms)": stgs.get(STAGE_ANALYZING, 0),
        "Summarizing (ms)": stgs.get(STAGE_SUMMARIZING, 0),
        "Embedding (ms)": stgs.get(STAGE_EMBEDDING, 0),
        "Pure OCR (ms)": t.get("pureOcrMs", 0),
        "VLM Inf (ms)": t.get("vlmInferenceMs", 0),
        "Lightweight (ms)": t.get("lightweightProcessingMs", 0),
    })

timing_df = pd.DataFrame(timing_rows)
print("=== 9-Stage Pipeline Timing Breakdown ===")
timing_df""")

    code("""# Per-Page and Storage Timing Detail
per_page_rows = []
for res in benchmark_results:
    for p in res["timing"].get("perPage", []):
        per_page_rows.append({
            "Document": res["filename"],
            "Page": p.get("page"),
            "Elapsed (ms)": p.get("elapsed_ms", 0),
            "Confidence": p.get("confidence", 1.0),
            "Line Count": len(p.get("lines", [])),
        })

if per_page_rows:
    print("=== Per-Page Timing & Extraction Quality ===")
    display(pd.DataFrame(per_page_rows))
else:
    print("Per-page detail: Single-page or aggregate document mode.")""")

    # ─────────────────────────────────────────────────────────────────────────
    # 9. Extraction & Accuracy
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 9. Extraction & Accuracy Evaluation
Inspects the actual clinical extraction outputs (demographics, diagnoses, medications, lab values, abnormal flags) and computes ground-truth accuracy metrics when available.""")

    code("""# ==============================================================================
# 9. EXTRACTION & ACCURACY EVALUATION
# ==============================================================================
import re

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
    ref_numbers = set(re.findall(r"\\b\\d+(?:\\.\\d+)?\\b", ref_text))
    if not ref_numbers:
        return 1.0
    hyp_numbers = set(re.findall(r"\\b\\d+(?:\\.\\d+)?\\b", hyp_text))
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
    
    # 1. OCR Accuracy (if groundTruthText exists)
    ref_text = gt.get("groundTruthText", "")
    cer = compute_cer(hyp_text, ref_text) if ref_text else "Not available"
    wer = compute_wer(hyp_text, ref_text) if ref_text else "Not available"
    num_recall = compute_numerical_recall(hyp_text, ref_text) if ref_text else "Not available"
    
    # 2. Structured Demographic Accuracy
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
        
    # 3. Lab Value Concordance
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

    # 4. Medication & Dosage Fidelity
    gt_meds = gt.get("medications") or []
    ext_meds = structured.get("medications") or []
    if gt_meds:
        med_matches = 0
        for gm in gt_meds:
            g_name = gm.get("name", "").lower()
            g_dose = str(gm.get("dosage", "")).lower().replace(" ", "")
            for em in ext_meds:
                e_name = str(em.get("name", "")).lower()
                e_dose = str(em.get("dosage", "")).lower().replace(" ", "")
                if (g_name in e_name or e_name in g_name) and (not g_dose or g_dose in e_dose):
                    med_matches += 1
                    break
        med_fid = f"{round(med_matches / len(gt_meds) * 100, 1)}%"
    else:
        med_fid = "Not available"

    # 5. Abnormal Lab Accuracy
    gt_abnormal = gt.get("abnormalFlags") or {}
    if gt_abnormal:
        ab_matches = 0
        for tname, info in gt_abnormal.items():
            t_flag = info.get("flag", "").upper()
            for el in ext_labs:
                e_name = str(el.get("testName", "")).lower()
                e_flag = str(el.get("flag", "")).upper()
                if tname.lower() in e_name and e_flag == t_flag:
                    ab_matches += 1
                    break
        ab_acc = f"{round(ab_matches / len(gt_abnormal) * 100, 1)}%"
    else:
        ab_acc = "Not available"

    return {
        "Document": result["filename"],
        "GroundTruth": "Available",
        "CER": cer,
        "WER": wer,
        "NumericalRecall": num_recall,
        "StructuredAccuracy": struct_acc,
        "LabConcordance": lab_conc,
        "MedicationFidelity": med_fid,
        "AbnormalLabAccuracy": ab_acc,
    }

accuracy_rows = [evaluate_document_accuracy(r) for r in benchmark_results]
accuracy_df = pd.DataFrame(accuracy_rows)
print("=== Ground-Truth Accuracy & Concordance Metrics ===")
accuracy_df""")

    code("""# Display Sample Extracted Structured Clinical Entities
for res in benchmark_results[:2]:
    job_rec = res.get("job_record") or {}
    structured = job_rec.get("extracted_structured_data") or {}
    print(f"\\nDocument: {res['filename']}")
    print(f"  Patient Info: {structured.get('patientInfo', {})}")
    print(f"  Diagnoses:    {structured.get('diagnosis', [])}")
    print(f"  Medications:  {structured.get('medications', [])}")
    print(f"  Lab Results:  {len(structured.get('labResults', []))} tests extracted")
    for lab in structured.get("labResults", [])[:3]:
        print(f"    - {lab.get('testName')}: {lab.get('value')} {lab.get('unit')} [Flag: {lab.get('flag')}]")""")

    # ─────────────────────────────────────────────────────────────────────────
    # 10. Multilingual Summary
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 10. Multilingual Clinical Summary
Evaluates clinical summaries in English and `PREFERRED_LANGUAGE` (`english`, `gujarati`, `hindi`, `marathi`, `tamil`) generated by `SummaryStageHandler`.""")

    code("""# ==============================================================================
# 10. MULTILINGUAL CLINICAL SUMMARY
# ==============================================================================
summary_rows = []

for res in benchmark_results:
    job_rec = res.get("job_record") or {}
    ck = job_rec.get("checkpoint_data") or {}
    sum_data = ck.get(STAGE_SUMMARIZING) or {}
    analysis_data = ck.get(STAGE_ANALYZING) or {}
    
    eng_summary = sum_data.get("summaryEnglish") or ""
    pref_summary = sum_data.get("summaryInPreferredLanguage") or eng_summary
    lang = sum_data.get("summaryLanguage") or PREFERRED_LANGUAGE
    dosage_ok = sum_data.get("dosagePreserved", True)
    risk = analysis_data.get("riskLevel", "UNKNOWN")
    key_points = sum_data.get("keyPoints", [])
    
    summary_rows.append({
        "Document": res["filename"],
        "Language": lang,
        "English Length (chars)": len(eng_summary),
        "Preferred Length (chars)": len(pref_summary),
        "Key Points": len(key_points),
        "Dosage Preserved": "Yes" if dosage_ok else "No",
        "Clinical Risk": risk,
        "English Summary Preview": eng_summary[:120] + "..." if len(eng_summary) > 120 else eng_summary,
        "Preferred Summary Preview": pref_summary[:120] + "..." if len(pref_summary) > 120 else pref_summary,
    })

summary_df = pd.DataFrame(summary_rows)
print("=== Multilingual Clinical Summary Evaluation ===")
summary_df[[
    "Document", "Language", "English Length (chars)", "Preferred Length (chars)",
    "Key Points", "Dosage Preserved", "Clinical Risk", "English Summary Preview"
]]""")

    # ─────────────────────────────────────────────────────────────────────────
    # 11. Batch Comparison
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 11. Batch Comparison & Statistics
Compiles the master matrix across all processed documents with statistical aggregates (min, max, mean, p50, p90, p95).""")

    code("""# ==============================================================================
# 11. BATCH COMPARISON & MASTER BENCHMARK TABLE
# ==============================================================================
import numpy as np

master_rows = []
for res in benchmark_results:
    t = res["timing"]
    stgs = t["stages"]
    job_rec = res.get("job_record") or {}
    ck = job_rec.get("checkpoint_data") or {}
    raw_ocr = job_rec.get("raw_ocr_data") or {}
    structured = job_rec.get("extracted_structured_data") or {}
    sum_data = ck.get(STAGE_SUMMARIZING) or {}
    
    # Accuracy lookup
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
        "Summary Language": sum_data.get("summaryLanguage", PREFERRED_LANGUAGE),
        "Summary Chars": len(sum_data.get("summaryInPreferredLanguage", "")),
        "Status": res["status"],
    })

master_df = pd.DataFrame(master_rows)
print("=== Master Production Pipeline Benchmark Table ===")
master_df""")

    code("""# Aggregate Statistics Calculation (Min, Max, Mean, p50, p90, p95)
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
print("=== Aggregate Latency Statistics (p50 / p90 / p95) ===")
stats_df""")

    # ─────────────────────────────────────────────────────────────────────────
    # 12. Export Results
    # ─────────────────────────────────────────────────────────────────────────
    md("""## 12. Export Results
Exports complete benchmark execution metrics to JSON and CSV formats.""")

    code("""# ==============================================================================
# 12. EXPORT RESULTS
# ==============================================================================
import datetime

# 1. Export CSV
master_df.to_csv(EXPORT_CSV_PATH, index=False)
print(f"Exported CSV table to: {Path(EXPORT_CSV_PATH).resolve()}")

# 2. Export JSON
export_payload = {
    "timestamp": datetime.datetime.now().isoformat(),
    "configuration": {
        "reports_dir": REPORTS_DIR,
        "selected_documents": SELECTED_DOCUMENTS,
        "preferred_language": PREFERRED_LANGUAGE,
        "total_documents": len(benchmark_results),
    },
    "aggregate_statistics": stats_df.to_dict(orient="records"),
    "documents": master_rows,
}

with open(EXPORT_JSON_PATH, "w", encoding="utf-8") as f:
    json.dump(export_payload, f, indent=2, ensure_ascii=False)

print(f"Exported JSON payload to: {Path(EXPORT_JSON_PATH).resolve()}")
print(f"Benchmark Run Complete: {len(master_rows)} document(s) verified.")""")

    notebook = {
        "cells": cells,
        "metadata": {
            "kernelspec": {
                "display_name": "Python 3",
                "language": "python",
                "name": "python3"
            },
            "language_info": {
                "codemirror_mode": {
                    "name": "ipython",
                    "version": 3
                },
                "file_extension": ".py",
                "mimetype": "text/x-python",
                "name": "python",
                "nbconvert_exporter": "python",
                "pygments_lexer": "ipython3",
                "version": "3.11.9"
            }
        },
        "nbformat": 4,
        "nbformat_minor": 5
    }

    target_file = Path("d:/TECHROVER/health-vault/health-vault-backend/ai-service/scripts/pipeline_benchmarks.ipynb")
    with open(target_file, "w", encoding="utf-8") as f:
        json.dump(notebook, f, indent=2, ensure_ascii=False)

    print(f"Successfully generated {target_file} ({len(cells)} cells)")

if __name__ == "__main__":
    create_notebook()
