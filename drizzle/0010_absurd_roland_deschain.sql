CREATE TYPE "public"."frequency" AS ENUM('ONCE_DAILY', 'TWICE_DAILY', 'THREE_TIMES_DAILY', 'AS_NEEDED');--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DEFAULT 'PENDING'::text;--> statement-breakpoint
DROP TYPE "public"."occurrence_status";--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('PENDING', 'COMPLETED');--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"public"."occurrence_status";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DATA TYPE "public"."occurrence_status" USING "status"::"public"."occurrence_status";--> statement-breakpoint
DROP INDEX "medication_reminders_type_idx";--> statement-breakpoint
DROP INDEX "occurrence_schedule_idx";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "best_taken" SET DATA TYPE "public"."best_taken";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "best_taken" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "food_frequency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "unit" SET DATA TYPE "public"."unit";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "reminder_before_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "reminder_before_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminders" ALTER COLUMN "frequency" SET DATA TYPE "undefined"."frequency";--> statement-breakpoint
ALTER TABLE "medication_reminders" ALTER COLUMN "frequency" SET DEFAULT 'ONCE_DAILY';--> statement-breakpoint
ALTER TABLE "medication_reminders" ALTER COLUMN "frequency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "actual_medication_time" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "actual_medication_time" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "completed_at" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medication_reminders" ADD COLUMN "refill_reminder_time" timestamp;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "medication_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "patient_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "is_overdue" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medication_reminder_occurrences_patient_id_idx" ON "medication_reminder_occurrences" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "occurrence_medication_idx" ON "medication_reminder_occurrences" USING btree ("medication_id");--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "dose_reminders";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "refill_alert";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "status";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "reminder_before_minutes";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "after_reminder_minutes";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "refill_alert_before_days";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "timezone";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "active";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "type";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "scheduled_at";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "notification_sent";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "notification_sent_at";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "skipped_at";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "missed_at";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "snooze_until";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "snooze_count";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "response_message";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "quantity_consumed";--> statement-breakpoint
DROP TYPE "public"."reminder_type";--> statement-breakpoint
DROP TYPE "public"."reminder_status";--> statement-breakpoint
DROP TYPE "public"."occurrence_type";