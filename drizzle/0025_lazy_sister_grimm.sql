ALTER TABLE "documents" ALTER COLUMN "document_type" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."document_type";--> statement-breakpoint
CREATE TYPE "public"."document_type" AS ENUM('PRESCERIPTION', 'LAB_REPORT', 'IMAGING_REPORT', 'DISCHARGE_SUMMARY', 'CONSULTATION_REPORT', 'SURGERY_PROCEDURE_REPORT', 'VACCINATION_RECORD', 'MEDICAL_CERTIFICATE', 'OTHER_MEDICAL_DOCUMENT');--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "document_type" SET DATA TYPE "public"."document_type" USING "document_type"::"public"."document_type";