ALTER TABLE "medications" ALTER COLUMN "frequency" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."frequency_type";--> statement-breakpoint
CREATE TYPE "public"."frequency_type" AS ENUM('Once Daily', 'Twice Daily', 'Three Times Daily', 'As Needed');--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "frequency" SET DATA TYPE "public"."frequency_type" USING "frequency"::"public"."frequency_type";--> statement-breakpoint
DROP TYPE "public"."frequency";--> statement-breakpoint
CREATE TYPE "public"."frequency" AS ENUM('Once Daily', 'Twice Daily', 'Three Times Daily', 'As Needed');