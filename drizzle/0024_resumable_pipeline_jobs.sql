-- Step 2 Migration: Resumable & Retryable Pipeline Tracking and Unique s3_key Index

-- 1. Guard check: Detect duplicate s3_key values before creating UNIQUE index
DO $$
DECLARE
    dup_count INTEGER;
BEGIN
    SELECT COUNT(*) INTO dup_count
    FROM (
        SELECT s3_key, COUNT(*)
        FROM documents
        GROUP BY s3_key
        HAVING COUNT(*) > 1
    ) dups;

    IF dup_count > 0 THEN
        RAISE EXCEPTION 'Cannot create UNIQUE index on documents(s3_key): found % duplicate s3_key values. Please deduplicate existing rows before running this migration.', dup_count;
    END IF;
END $$;

-- 2. Create UNIQUE index on documents(s3_key)
CREATE UNIQUE INDEX IF NOT EXISTS "documents_s3_key_key" ON "documents" ("s3_key");

-- 3. Extend document_processing_jobs with checkpoint, retry, and heartbeat columns
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "stage_status" varchar(32);
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "completed_stages" text[] DEFAULT '{}'::text[] NOT NULL;
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "retryable" boolean;
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "requires_reupload" boolean DEFAULT false NOT NULL;
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "checkpoint_data" jsonb DEFAULT '{}'::jsonb NOT NULL;
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp;

CREATE INDEX IF NOT EXISTS "document_processing_jobs_heartbeat_idx" ON "document_processing_jobs" ("last_heartbeat_at");
