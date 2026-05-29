ALTER TABLE "medication_reminders" ADD COLUMN "frequency" "frequency" DEFAULT 'ONCE_DAILY' NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "routineBase";