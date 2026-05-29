ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DEFAULT 'PENDING'::text;--> statement-breakpoint
DROP TYPE "public"."occurrence_status";--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('PENDING', 'COMPLETED', 'OVERDUE');--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"public"."occurrence_status";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DATA TYPE "public"."occurrence_status" USING "status"::"public"."occurrence_status";--> statement-breakpoint
DROP INDEX "medication_reminders_type_idx";--> statement-breakpoint
DROP INDEX "occurrence_schedule_idx";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "actual_medication_time" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "actual_medication_time" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "notification_sent_at" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "notification_sent_at" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "completed_at" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "patient_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "reminder_send_time" timestamp NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "follow_up_check_time" timestamp DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medication_reminder_occurrences_patient_id_idx" ON "medication_reminder_occurrences" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "occurrence_schedule_idx" ON "medication_reminder_occurrences" USING btree ("reminder_send_time");--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "timezone";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "scheduled_at";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "skipped_at";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "missed_at";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "snooze_until";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "snooze_count";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "response_message";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "quantity_consumed";--> statement-breakpoint
DROP TYPE "public"."reminder_type";--> statement-breakpoint
DROP TYPE "public"."reminder_status";--> statement-breakpoint
DROP TYPE "public"."occurrence_type";