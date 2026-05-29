ALTER TABLE "medication_reminders" RENAME COLUMN "frequency" TO "routineBase";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "best_taken" SET DATA TYPE "public"."best_taken";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "best_taken" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "food_frequency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "unit" SET DATA TYPE "public"."unit";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "is_follow_up" boolean DEFAULT false;