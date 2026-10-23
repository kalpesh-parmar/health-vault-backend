ALTER TYPE "public"."occurrence_status" ADD VALUE 'SKIPPED';--> statement-breakpoint
ALTER TYPE "public"."occurrence_status" ADD VALUE 'CANCELLED';--> statement-breakpoint
CREATE TABLE "medication_occurrence_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"occurrence_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"from_status" varchar(32) NOT NULL,
	"to_status" varchar(32) NOT NULL,
	"completion_classification" varchar(32),
	"action_timestamp" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"delay_minutes" integer,
	"actor" varchar(32) DEFAULT 'PATIENT' NOT NULL,
	"notes" varchar(500),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patient_lab_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid,
	"report_id" varchar(255),
	"canonical_key" varchar(128) NOT NULL,
	"test_name" varchar(255) NOT NULL,
	"value_numeric" double precision,
	"value_text" text,
	"unit" varchar(64),
	"reference_range" varchar(255),
	"flag" varchar(32) DEFAULT 'NORMAL' NOT NULL,
	"is_abnormal" boolean DEFAULT false NOT NULL,
	"is_critical" boolean DEFAULT false NOT NULL,
	"test_date" timestamp with time zone,
	"page_no" integer DEFAULT 1 NOT NULL,
	"confidence" double precision,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "file_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."file_type";--> statement-breakpoint
CREATE TYPE "public"."file_type" AS ENUM('docx', 'application/msword', 'image/jpeg', 'application/pdf', 'image/png', 'image/tiff', 'image/tiff', 'text/plain', 'image/webp', 'image/jpg');--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "file_type" SET DATA TYPE "public"."file_type" USING "file_type"::"public"."file_type";--> statement-breakpoint
DROP INDEX "document_ai_summary_report_type_idx";--> statement-breakpoint
DROP INDEX "document_ai_summary_report_date_idx";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "delay_minutes" integer;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "completion_classification" varchar(32);--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "skip_reason" varchar(255);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "timezone" varchar(64) DEFAULT 'Asia/Kolkata' NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_occurrence_history" ADD CONSTRAINT "medication_occurrence_history_occurrence_id_medication_reminder_occurrences_id_fk" FOREIGN KEY ("occurrence_id") REFERENCES "public"."medication_reminder_occurrences"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_occurrence_history" ADD CONSTRAINT "medication_occurrence_history_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_lab_results" ADD CONSTRAINT "patient_lab_results_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "patient_lab_results" ADD CONSTRAINT "patient_lab_results_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "med_occ_hist_occurrence_id_idx" ON "medication_occurrence_history" USING btree ("occurrence_id");--> statement-breakpoint
CREATE INDEX "med_occ_hist_patient_id_idx" ON "medication_occurrence_history" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "med_occ_hist_action_timestamp_idx" ON "medication_occurrence_history" USING btree ("action_timestamp");--> statement-breakpoint
CREATE INDEX "patient_lab_results_user_canonical_date_idx" ON "patient_lab_results" USING btree ("user_id","canonical_key","test_date");--> statement-breakpoint
CREATE INDEX "patient_lab_results_document_id_idx" ON "patient_lab_results" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "patient_lab_results_user_date_idx" ON "patient_lab_results" USING btree ("user_id","test_date");--> statement-breakpoint
CREATE INDEX "patient_lab_results_canonical_key_idx" ON "patient_lab_results" USING btree ("canonical_key");--> statement-breakpoint
CREATE INDEX "occurrence_status_classification_idx" ON "medication_reminder_occurrences" USING btree ("patient_id","status","completion_classification");--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "hospital_name";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "doctor_name";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "patient_name";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "report_type";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "report_date";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "diagnosis";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "observations";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "recommendations";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "medications";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "allergies";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "blood_group";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "test_results";--> statement-breakpoint
ALTER TABLE "document_ai_summary" DROP COLUMN "summary";