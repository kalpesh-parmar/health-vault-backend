-- Step 1: Add new values to occurrence_status enum
ALTER TYPE "public"."occurrence_status" ADD VALUE IF NOT EXISTS 'SKIPPED';--> statement-breakpoint
ALTER TYPE "public"."occurrence_status" ADD VALUE IF NOT EXISTS 'CANCELLED';--> statement-breakpoint

-- Step 2: Add timezone to patients table
ALTER TABLE "patients" ADD COLUMN IF NOT EXISTS "timezone" varchar(64) DEFAULT 'Asia/Kolkata' NOT NULL;--> statement-breakpoint

-- Step 3: Add adherence tracking fields to medication_reminder_occurrences
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN IF NOT EXISTS "delay_minutes" integer;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN IF NOT EXISTS "completion_classification" varchar(32);--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN IF NOT EXISTS "skip_reason" varchar(255);--> statement-breakpoint

-- Step 4: Create indexes for dashboard adherence queries
CREATE INDEX IF NOT EXISTS "occurrence_status_classification_idx" ON "medication_reminder_occurrences" USING btree ("patient_id", "status", "completion_classification");--> statement-breakpoint

-- Step 5: Create medication_occurrence_history audit table
CREATE TABLE IF NOT EXISTS "medication_occurrence_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"from_status" varchar(32) NOT NULL,
	"to_status" varchar(32) NOT NULL,
	"completion_classification" varchar(32),
	"completed_at" timestamp with time zone,
	"delay_minutes" integer,
	"action_timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"actor" varchar(32) DEFAULT 'PATIENT' NOT NULL,
	"notes" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint

-- Step 6: Add constraints and indexes on medication_occurrence_history
ALTER TABLE "medication_occurrence_history" ADD CONSTRAINT "med_occ_hist_occurrence_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."medication_reminder_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_occurrence_history" ADD CONSTRAINT "med_occ_hist_patient_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "med_occ_hist_occurrence_id_idx" ON "medication_occurrence_history" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "med_occ_hist_patient_id_idx" ON "medication_occurrence_history" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "med_occ_hist_action_timestamp_idx" ON "medication_occurrence_history" USING btree ("action_timestamp");
