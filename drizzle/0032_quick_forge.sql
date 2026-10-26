ALTER TABLE "documents" ALTER COLUMN "file_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."file_type";--> statement-breakpoint
CREATE TYPE "public"."file_type" AS ENUM('docx', 'application/msword', 'image/jpeg', 'application/pdf', 'image/png', 'image/tiff', 'text/plain', 'image/webp', 'image/jpg');--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "file_type" SET DATA TYPE "public"."file_type" USING "file_type"::"public"."file_type";