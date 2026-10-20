import asyncio
import sys
from sqlalchemy import text
from app.infrastructure.db.session import Database

async def test_cast():
    db = Database("postgresql://postgres:postgres@localhost:5432/health_vault")
    async for session in db.session():
        # Test 1: CAST string to document_type
        res = await session.execute(
            text("SELECT CAST(:doc_type AS document_type) as val"),
            {"doc_type": "LAB_REPORT"}
        )
        print("Test 1 (LAB_REPORT):", res.scalar())

        # Test 2: CAST NULL to document_type
        res = await session.execute(
            text("SELECT CAST(:doc_type AS document_type) as val"),
            {"doc_type": None}
        )
        print("Test 2 (None):", res.scalar())

        # Test 3: COALESCE with existing
        res = await session.execute(
            text("SELECT COALESCE(CAST(:doc_type AS document_type), 'PRESCRIPTION'::document_type) as val"),
            {"doc_type": None}
        )
        print("Test 3 (COALESCE None):", res.scalar())

        res = await session.execute(
            text("SELECT COALESCE(CAST(:doc_type AS document_type), 'PRESCRIPTION'::document_type) as val"),
            {"doc_type": "IMAGING_REPORT"}
        )
        print("Test 4 (COALESCE IMAGING_REPORT):", res.scalar())
        break

asyncio.run(test_cast())
