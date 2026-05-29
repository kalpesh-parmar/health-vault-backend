ALTER TABLE "medication_reminder_occurrences" DROP CONSTRAINT "medication_reminder_occurrences_medication_id_medications_id_fk";
--> statement-breakpoint
DROP INDEX "occurrence_medication_idx";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "medication_id";