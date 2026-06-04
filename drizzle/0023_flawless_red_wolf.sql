DROP INDEX "before_reminder_idx";--> statement-breakpoint
DROP INDEX "after_reminder_idx";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "reminder_before_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "reminder_before_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminders" ADD COLUMN "refill_reminder_time" timestamp;--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "refill_alert";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "is_reminder";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "reminder_before_minutes";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "after_reminder_minutes";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "refill_alert_before_days";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "active";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "before_reminder_time";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "after_reminder_time";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "notification_sent";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "notification_sent_at";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" DROP COLUMN "refill_reminder_time";