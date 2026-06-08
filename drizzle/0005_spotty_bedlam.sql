ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DEFAULT 'PENDING'::text;--> statement-breakpoint
DROP TYPE "public"."occurrence_status";--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('PENDING', 'SENT', 'COMPLETED', 'MISSED', 'SKIPPED', 'SNOOZED');--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DEFAULT 'PENDING'::"public"."occurrence_status";--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ALTER COLUMN "status" SET DATA TYPE "public"."occurrence_status" USING "status"::"public"."occurrence_status";