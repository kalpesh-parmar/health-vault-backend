ALTER TABLE "documents" ALTER COLUMN "file_name" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "structured_extracted_data" SET DATA TYPE jsonb;