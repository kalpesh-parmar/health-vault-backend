ALTER TABLE "refill_count" RENAME COLUMN "total_quantity" TO "before_refill_total_quantity";--> statement-breakpoint
ALTER TABLE "refill_count" RENAME COLUMN "remaining_quantity" TO "before_refill_remaining_quantity";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "start_date" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "end_date" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "refill_count" ADD COLUMN "after_refill_total_quantity" integer NOT NULL;--> statement-breakpoint
ALTER TABLE "refill_count" ADD COLUMN "after_refill_remaining_quantity" integer NOT NULL;