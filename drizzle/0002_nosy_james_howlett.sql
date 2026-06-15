ALTER TABLE "medications" ALTER COLUMN "medication_schedule" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "food_frequency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "medication_times";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "best_taken";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "remaining_quantity";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "dose_reminders";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "refill_alert";