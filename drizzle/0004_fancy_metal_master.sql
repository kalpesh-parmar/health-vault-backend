ALTER TABLE "medications" RENAME COLUMN "medication_time" TO "medication_times";--> statement-breakpoint
ALTER TABLE "medications" RENAME COLUMN "remaining_pills" TO "remaining_quantity";--> statement-breakpoint
ALTER TABLE "medications" ADD COLUMN "unit" varchar(20) NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ADD COLUMN "daily_consumption" integer DEFAULT 0 NOT NULL;