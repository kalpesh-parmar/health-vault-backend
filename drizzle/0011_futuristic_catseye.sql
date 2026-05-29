ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DEFAULT 'PENDING'::text;--> statement-breakpoint
DROP TYPE "public"."occurrence_status";--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('PENDING', 'COMPLETED');--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"public"."occurrence_status";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DATA TYPE "public"."occurrence_status" USING "status"::"public"."occurrence_status";--> statement-breakpoint
DROP INDEX "occurrence_schedule_idx";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "notification_sent_at" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "before_reminder_time" timestamp;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "after_reminder_time" timestamp;--> statement-breakpoint
CREATE INDEX "before_reminder_idx" ON "medication_reminder_occurrences" USING btree ("before_reminder_time");--> statement-breakpoint
CREATE INDEX "after_reminder_idx" ON "medication_reminder_occurrences" USING btree ("after_reminder_time");--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "reminder_send_time";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "follow_up_check_time";