ALTER TABLE "documents" ALTER COLUMN "s3_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "file_path";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "blood_type";