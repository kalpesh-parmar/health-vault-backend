CREATE TYPE "public"."provider" AS ENUM('google', 'facebook');--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "medication_schedule" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "food_frequency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "provider" "provider";--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "provider_id" integer;