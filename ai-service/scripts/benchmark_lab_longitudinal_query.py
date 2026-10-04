"""Micro-benchmark verifying longitudinal lab results query execution latency against PostgreSQL.

Target: p95 and mean execution time < 5.0 ms using composite index:
(user_id, canonical_key, test_date DESC NULLS LAST).
"""

from __future__ import annotations

import asyncio
from pathlib import Path
import statistics
import sys
import time
import uuid

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from datetime import datetime, timedelta, timezone

from app.infrastructure.db.models import Patient, PatientLabResult
from app.infrastructure.db.repositories.lab_result_repository import LabResultRepository
from app.infrastructure.db.session import Database
from app.settings import Settings
from sqlalchemy import delete, text


async def run_benchmark():
    settings = Settings()
    db = Database(settings.database_url)
    repo = LabResultRepository(db=db)

    # 1. Resolve or create benchmark user_id
    created_patient = False
    async with repo._get_session() as session:
        res = await session.execute(text("SELECT id FROM patients LIMIT 1"))
        row = res.first()
        if row:
            test_user_id = row[0]
        else:
            test_user_id = uuid.uuid4()
            from app.infrastructure.db.models import Patient
            session.add(Patient(id=test_user_id, full_name="Benchmark User", soft_delete=False))
            await session.commit()
            created_patient = True

    base_date = datetime(2025, 1, 1, 9, 0, 0, tzinfo=timezone.utc)
    report_tag = f"bench_{uuid.uuid4().hex[:8]}"

    print(f"[*] Setting up benchmark dataset for user_id={test_user_id}, report_tag={report_tag}...")

    # Generate 100 historical lab entries across different panels
    panels = [
        ("Fasting Blood Sugar", "fasting_blood_glucose", 90.0, "mg/dL"),
        ("HbA1c", "hba1c", 5.6, "%"),
        ("Hemoglobin", "hemoglobin", 14.5, "g/dL"),
        ("Serum Creatinine", "creatinine", 0.9, "mg/dL"),
        ("TSH", "tsh", 2.1, "mIU/L"),
    ]

    lab_items = []
    for i in range(100):
        test_name, canonical_key, base_val, unit = panels[i % len(panels)]
        item_date = base_date + timedelta(days=i * 7)
        lab_items.append({
            "testName": test_name,
            "canonicalKey": canonical_key,
            "value": round(base_val + (i % 5) * 2.5, 2),
            "unit": unit,
            "testDate": item_date.isoformat(),
            "pageNo": 1,
            "confidence": 0.97,
            "provenance": "benchmark_test",
        })

    # Persist dataset
    persisted = await repo.persist_lab_results(
        user_id=test_user_id,
        document_id=None,
        report_id=report_tag,
        lab_items=lab_items,
        test_date=base_date,
    )
    print(f"[+] Persisted {len(persisted)} lab results for benchmark.")

    async with repo._get_session() as session:
        # Warmup queries
        for _ in range(5):
            await repo.query_longitudinal(user_id=test_user_id, canonical_key="fasting_blood_glucose", limit=20, session=session)

        # Benchmark: 100 iterations of longitudinal query
        iterations = 100
        latencies_ms: list[float] = []

        for _ in range(iterations):
            t0 = time.perf_counter()
            res = await repo.query_longitudinal(
                user_id=test_user_id,
                canonical_key="fasting_blood_glucose",
                limit=20,
                session=session,
            )
            t1 = time.perf_counter()
            latencies_ms.append((t1 - t0) * 1000)

    # Clean up test dataset
    async with repo._get_session() as session:
        await session.execute(
            delete(PatientLabResult).where(PatientLabResult.report_id == report_tag)
        )
        if created_patient:
            await session.execute(
                delete(Patient).where(Patient.id == test_user_id)
            )
        await session.commit()
    await db.close()

    mean_ms = statistics.mean(latencies_ms)
    median_ms = statistics.median(latencies_ms)
    p95_ms = sorted(latencies_ms)[int(iterations * 0.95)]
    p99_ms = sorted(latencies_ms)[int(iterations * 0.99)]
    min_ms = min(latencies_ms)
    max_ms = max(latencies_ms)

    print("\n" + "=" * 50)
    print("LONGITUDINAL LAB RESULTS QUERY BENCHMARK")
    print("=" * 50)
    print(f"Iterations : {iterations}")
    print(f"Returned Rows : {res['count']}")
    print(f"Mean Latency  : {mean_ms:.3f} ms")
    print(f"Median (p50)  : {median_ms:.3f} ms")
    print(f"p95 Latency   : {p95_ms:.3f} ms")
    print(f"p99 Latency   : {p99_ms:.3f} ms")
    print(f"Min Latency   : {min_ms:.3f} ms")
    print(f"Max Latency   : {max_ms:.3f} ms")
    print("=" * 50)

    assert p95_ms < 5.0, f"Benchmark FAILED: p95 latency {p95_ms:.3f} ms exceeds target of 5.0 ms"
    print("\n>>> BENCHMARK PASSED: p95 latency < 5.0 ms target achieved! <<<\n")


if __name__ == "__main__":
    asyncio.run(run_benchmark())
