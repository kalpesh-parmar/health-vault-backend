DROP TABLE "otp_verifications" CASCADE;--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "summary_in_preferred_language";--> statement-breakpoint
ALTER TABLE "documents" DROP COLUMN "deleted_at";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "is_verified";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "is_active";