-- Rollback script for 0028_drop_duplicate_ai_summary_columns.sql
ALTER TABLE "document_ai_summary"
    ADD COLUMN IF EXISTS "hospital_name" varchar(255),
    ADD COLUMN IF EXISTS "doctor_name" varchar(255),
    ADD COLUMN IF EXISTS "patient_name" varchar(255),
    ADD COLUMN IF EXISTS "report_type" varchar(128),
    ADD COLUMN IF EXISTS "report_date" timestamp,
    ADD COLUMN IF EXISTS "diagnosis" text,
    ADD COLUMN IF EXISTS "observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD COLUMN IF EXISTS "recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD COLUMN IF EXISTS "medications" jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD COLUMN IF EXISTS "allergies" jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD COLUMN IF EXISTS "blood_group" varchar(8),
    ADD COLUMN IF EXISTS "test_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
    ADD COLUMN IF EXISTS "summary" text;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "document_ai_summary_report_type_idx" ON "document_ai_summary" ("report_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "document_ai_summary_report_date_idx" ON "document_ai_summary" ("report_date");
