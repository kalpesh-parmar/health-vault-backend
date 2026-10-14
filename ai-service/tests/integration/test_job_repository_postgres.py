from __future__ import annotations

import json
import os
import uuid
from uuid import UUID

import pytest
from sqlalchemy import text

from app.core.errors import sanitize_pipeline_error
from app.infrastructure.db.repositories.job_repository import JobRepository
from app.infrastructure.db.session import Database

TEST_DB_URL = os.getenv(
    "DATABASE_URL",
    "postgresql+asyncpg://postgres:123@localhost:5432/health-vault-v4",
)
if TEST_DB_URL.startswith("postgres://"):
    TEST_DB_URL = TEST_DB_URL.replace("postgres://", "postgresql+asyncpg://", 1)


@pytest.fixture
async def db():
    database = Database(TEST_DB_URL)
    yield database
    await database.close()


@pytest.fixture
async def sample_job(db: Database):
    """Inserts a fresh RUNNING job into PostgreSQL and cleans it up after test."""
    job_id = uuid.uuid4()
    file_key = f"test/doc_{job_id}.pdf"

    # Fetch a valid user_id (patient id)
    user_id = None
    async for session in db.session():
        row = (await session.execute(text("SELECT id FROM patients LIMIT 1"))).first()
        if row:
            user_id = row[0]
        break

    if not user_id:
        user_id = uuid.uuid4()
        async for session in db.session():
            await session.execute(
                text(
                    "INSERT INTO patients (id, patient_code, full_name, created_at, updated_at) "
                    "VALUES (:id, 'TEST-PATIENT', 'Test Patient', NOW(), NOW())"
                ),
                {"id": user_id},
            )
            await session.commit()
            break

    insert_sql = text(
        """
        INSERT INTO document_processing_jobs (
            id, file_key, user_id, status, stage, stage_status, attempt_count,
            percentage, message, checkpoint_data, created_at, updated_at
        ) VALUES (
            :id, :file_key, :user_id, 'RUNNING', 'VALIDATING', 'IN_PROGRESS', 1,
            10, 'Testing job', CAST(:checkpoint_data AS JSONB), NOW(), NOW()
        )
        """
    )
    initial_checkpoint = {"initial": "value", "seed": 123}
    async for session in db.session():
        await session.execute(
            insert_sql,
            {
                "id": job_id,
                "file_key": file_key,
                "user_id": user_id,
                "checkpoint_data": json.dumps(initial_checkpoint),
            },
        )
        await session.commit()
        break

    yield job_id

    # Cleanup
    async for session in db.session():
        await session.execute(
            text("DELETE FROM document_processing_jobs WHERE id = :id"),
            {"id": job_id},
        )
        await session.commit()


@pytest.mark.asyncio
async def test_update_job_checkpoint_attempt_count_variations(db: Database, sample_job: UUID):
    repo = JobRepository(db)

    # 1. attempt_count = None (previously threw AmbiguousParameterError: could not determine data type of $10)
    res_none = await repo.update_job_checkpoint(
        job_id=sample_job,
        stage="VALIDATING",
        stage_status="IN_PROGRESS",
        percentage=20,
        message="Validating with attempt_count=None",
        completed_stages=["VALIDATING"],
        checkpoint_data={"step": "validating"},
        attempt_count=None,
    )
    assert res_none is True

    # 2. attempt_count = 1 (matching current attempt_count in DB)
    res_match = await repo.update_job_checkpoint(
        job_id=sample_job,
        stage="UPLOADING",
        stage_status="IN_PROGRESS",
        percentage=30,
        message="Validating with matching attempt_count=1",
        completed_stages=["VALIDATING", "UPLOADING"],
        checkpoint_data={"step": "uploading"},
        attempt_count=1,
    )
    assert res_match is True

    # 3. attempt_count = 99 (mismatched attempt_count -> rowcount must be 0)
    res_no_match = await repo.update_job_checkpoint(
        job_id=sample_job,
        stage="OCR_RUNNING",
        stage_status="IN_PROGRESS",
        percentage=40,
        message="Validating with mismatched attempt_count=99",
        completed_stages=["VALIDATING", "UPLOADING"],
        checkpoint_data={"step": "ocr"},
        attempt_count=99,
    )
    assert res_no_match is False


@pytest.mark.asyncio
async def test_complete_job_attempt_count_variations(db: Database, sample_job: UUID):
    repo = JobRepository(db)

    # 1. attempt_count = 99 (mismatch -> returns False)
    res_mismatch = await repo.complete_job(
        job_id=sample_job,
        message="Completing with mismatched attempt_count",
        completed_stages=["VALIDATING", "EMBEDDING"],
        checkpoint_data={"final": True},
        attempt_count=99,
    )
    assert res_mismatch is False

    # 2. attempt_count = None (previously threw AmbiguousParameterError)
    res_none = await repo.complete_job(
        job_id=sample_job,
        message="Completing with attempt_count=None",
        completed_stages=["VALIDATING", "EMBEDDING"],
        checkpoint_data={"final": True},
        attempt_count=None,
    )
    assert res_none is True

    # Verify job status in DB is COMPLETED
    async for session in db.session():
        row = (
            await session.execute(
                text("SELECT status, percentage FROM document_processing_jobs WHERE id = :id"),
                {"id": sample_job},
            )
        ).mappings().first()
        assert row["status"] == "COMPLETED"
        assert row["percentage"] == 100


@pytest.mark.asyncio
async def test_fail_job_payload_and_attempt_variations(db: Database, sample_job: UUID):
    repo = JobRepository(db)

    # 1. checkpoint_data = None and attempt_count = None
    # (Previously threw syntax error near ':' due to :checkpoint_data::jsonb AND AmbiguousParameterError on attempt_count)
    res_none = await repo.fail_job(
        job_id=sample_job,
        error="Failure test with None payload",
        failed_stage="VALIDATING",
        checkpoint_data=None,
        attempt_count=None,
    )
    assert res_none is True

    # Verify status is FAILED and initial checkpoint_data was preserved by COALESCE
    async for session in db.session():
        row = (
            await session.execute(
                text("SELECT status, error, checkpoint_data FROM document_processing_jobs WHERE id = :id"),
                {"id": sample_job},
            )
        ).mappings().first()
        assert row["status"] == "FAILED"
        assert row["error"] == "Failure test with None payload"
        # Seed checkpoint data preserved
        assert row["checkpoint_data"].get("seed") == 123

    # Reset back to RUNNING for next check
    async for session in db.session():
        await session.execute(
            text("UPDATE document_processing_jobs SET status = 'RUNNING' WHERE id = :id"),
            {"id": sample_job},
        )
        await session.commit()

    # 2. checkpoint_data with JSON payload and attempt_count = 1
    custom_checkpoint = {"stage": "VALIDATING", "custom_field": "val_123"}
    res_payload = await repo.fail_job(
        job_id=sample_job,
        error="Stage failure with payload",
        failed_stage="VALIDATING",
        checkpoint_data=custom_checkpoint,
        attempt_count=1,
    )
    assert res_payload is True

    async for session in db.session():
        row = (
            await session.execute(
                text("SELECT status, checkpoint_data FROM document_processing_jobs WHERE id = :id"),
                {"id": sample_job},
            )
        ).mappings().first()
        assert row["status"] == "FAILED"
        assert row["checkpoint_data"].get("custom_field") == "val_123"


@pytest.mark.asyncio
async def test_error_column_never_contains_sql_or_parameters(db: Database, sample_job: UUID):
    repo = JobRepository(db)

    # Simulated raw SQLAlchemy DBAPI error with SQL and parameters
    leaked_raw_error = (
        "(sqlalchemy.dialects.postgresql.asyncpg.Error) syntax error at or near ':'\n"
        "[SQL: UPDATE document_processing_jobs SET checkpoint_data = :checkpoint_data::jsonb WHERE id = :job_id]\n"
        "[parameters: {'job_id': '8773c773-0000', 'checkpoint_data': '{\"patient_ssn\": \"123-45-6789\"}'}]"
    )

    sanitized = sanitize_pipeline_error(leaked_raw_error)
    assert sanitized == "DATABASE_ERROR"
    assert "[SQL:" not in sanitized
    assert "[parameters:" not in sanitized

    res = await repo.fail_job(
        job_id=sample_job,
        error=sanitized,
        failed_stage="VALIDATING",
        attempt_count=None,
    )
    assert res is True

    async for session in db.session():
        row = (
            await session.execute(
                text("SELECT error, message FROM document_processing_jobs WHERE id = :id"),
                {"id": sample_job},
            )
        ).mappings().first()
        assert row["error"] == "DATABASE_ERROR"
        assert "[SQL:" not in row["error"]
        assert "[parameters:" not in row["error"]
        if row["message"]:
            assert "[SQL:" not in row["message"]
            assert "[parameters:" not in row["message"]
