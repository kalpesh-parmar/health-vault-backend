DROP INDEX "patients_phone_idx";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "user_name";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "age";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "phone";
