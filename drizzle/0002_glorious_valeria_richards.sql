ALTER TABLE "patients" ALTER COLUMN "user_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "first_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "last_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "full_name" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "email" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "password" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "gender" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "phone" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ADD COLUMN "summary_gujarati" text;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "mobile" varchar(20);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "firebase_uid" varchar(255);--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "last_login_at" timestamp;--> statement-breakpoint
CREATE UNIQUE INDEX "patients_mobile_unique_idx" ON "patients" USING btree ("mobile");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_firebase_uid_unique_idx" ON "patients" USING btree ("firebase_uid");--> statement-breakpoint
CREATE INDEX "patients_mobile_idx" ON "patients" USING btree ("mobile");