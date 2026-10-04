import asyncio
import statistics
import time
import uuid
from datetime import datetime, timezone
from app.infrastructure.db.session import Database
from app.settings import Settings
from sqlalchemy import text


async def test_speed():
    db = Database(Settings().database_url)
    async with db.session_factory() as session:
        # warm up
        await session.execute(text("SELECT 1"))

        # Measure 100 queries
        times = []
        for _ in range(100):
            t0 = time.perf_counter()
            res = await session.execute(
                text(
                    """
                    SELECT id, user_id, document_id, report_id, canonical_key, test_name,
                           value_numeric, value_text, unit, reference_range, flag,
                           is_abnormal, is_critical, test_date, page_no, confidence,
                           metadata, created_at
                    FROM patient_lab_results
                    WHERE user_id = :uid AND canonical_key = :key
                    ORDER BY test_date DESC NULLS LAST
                    LIMIT 20
                    """
                ),
                {"uid": uuid.uuid4(), "key": "fasting_blood_glucose"},
            )
            rows = res.mappings().all()
            t1 = time.perf_counter()
            times.append((t1 - t0) * 1000)

        mean_ms = statistics.mean(times)
        p95_ms = sorted(times)[int(len(times) * 0.95)]
        print(f"Direct raw query: Mean={mean_ms:.3f} ms, p95={p95_ms:.3f} ms")

    await db.close()

if __name__ == "__main__":
    asyncio.run(test_speed())
