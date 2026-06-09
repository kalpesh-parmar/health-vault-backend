ALTER TABLE "medications" ALTER COLUMN "start_date" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "end_date" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medications" ADD COLUMN "medication_schedule" json NOT NULL;--> statement-breakpoint
ALTER TABLE "refill_count" ADD COLUMN "before_refill_total_quantity" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "refill_count" ADD COLUMN "before_refill_remaining_quantity" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "refill_count" ADD COLUMN "after_refill_total_quantity" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "refill_count" ADD COLUMN "after_refill_remaining_quantity" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "medication_times";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "best_taken";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "frequency";--> statement-breakpoint
ALTER TABLE "medication_reminders" DROP COLUMN "medication_times";--> statement-breakpoint
ALTER TABLE "refill_count" DROP COLUMN "total_quantity";--> statement-breakpoint
ALTER TABLE "refill_count" DROP COLUMN "remaining_quantity";