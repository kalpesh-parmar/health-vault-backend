-- Down migration for development rollback
DROP TABLE IF EXISTS "medication_occurrence_history" CASCADE;--> statement-breakpoint
DROP INDEX IF EXISTS "occurrence_status_classification_idx";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN IF EXISTS "skip_reason";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN IF EXISTS "completion_classification";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN IF EXISTS "delay_minutes";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN IF EXISTS "timezone";
