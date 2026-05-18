ALTER TABLE "documents" ALTER COLUMN "s3_bucket" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "s3_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "ocr_status" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "hospital_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "doctor_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "id" SET DATA TYPE uuid;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "id" SET DEFAULT gen_random_uuid();--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "user_name" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "date_of_birth";