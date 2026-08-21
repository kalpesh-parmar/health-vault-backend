ALTER TABLE "chat_history" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chat_history" CASCADE;--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "document_type" SET DATA TYPE text;--> statement-breakpoint

DROP TYPE "public"."document_type";--> statement-breakpoint

CREATE TYPE "public"."document_type" AS ENUM('PRESCERIPTION', 'LAB_REPORT', 'IMAGING_REPORT', 'DISCHARGE_SUMMARY', 'CONSULTATION_REPORT', 'SURGERY_PROCEDURE_REPORT', 'VACCINATION_RECORD', 'MEDICAL_CERTIFICATE', 'OTHER_MEDICAL_DOCUMENT');--> statement-breakpoint

ALTER TABLE "documents"
ALTER COLUMN "document_type"
SET DATA TYPE "public"."document_type"
USING (
  CASE "document_type"
    WHEN 'prescription' THEN 'PRESCRIPTION'
    WHEN 'lab report' THEN 'LAB_REPORT'
    WHEN 'imaging report' THEN 'IMAGING_REPORT'
    WHEN 'discharge summary' THEN 'DISCHARGE_SUMMARY'
    WHEN 'consultation report' THEN 'CONSULTATION_REPORT'
    WHEN 'surgery procedure report' THEN 'SURGERY_PROCEDURE_REPORT'
    WHEN 'vaccination record' THEN 'VACCINATION_RECORD'
    WHEN 'medical certificate' THEN 'MEDICAL_CERTIFICATE'
    WHEN 'medical_document' THEN 'OTHER_MEDICAL_DOCUMENT'
    ELSE 'OTHER_MEDICAL_DOCUMENT'
  END
)::"public"."document_type";

DROP INDEX "chat_sessions_document_id_idx";--> statement-breakpoint
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "stage_status" varchar(32);--> statement-breakpoint
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "attempt_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "completed_stages" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "retryable" boolean;--> statement-breakpoint
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "requires_reupload" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "checkpoint_data" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "document_processing_jobs" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "documents_s3_key_key" ON "documents" USING btree ("s3_key");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_processing_jobs_heartbeat_idx" ON "document_processing_jobs" USING btree ("last_heartbeat_at");--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "document_id";