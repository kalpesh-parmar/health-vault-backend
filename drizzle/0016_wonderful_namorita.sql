ALTER TABLE "medications" ADD COLUMN "medication_schedule" json NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "medication_times";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "best_taken";