CREATE TYPE "public"."login_type" AS ENUM('mobile', 'social');--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"login_type" "login_type" NOT NULL,
	"provider" "provider" NOT NULL,
	"identifier" varchar(255) NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp,
	"blocked_until" timestamp,
	"soft_delete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "auth_providers" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "login_attempts" ALTER COLUMN "provider" SET DATA TYPE text;--> statement-breakpoint
DROP TYPE "public"."provider";--> statement-breakpoint
CREATE TYPE "public"."provider" AS ENUM('google', 'facebook', 'apple', 'microsoft', 'mobile');--> statement-breakpoint
ALTER TABLE "auth_providers" ALTER COLUMN "provider" SET DATA TYPE "public"."provider" USING "provider"::"public"."provider";--> statement-breakpoint
ALTER TABLE "login_attempts" ALTER COLUMN "provider" SET DATA TYPE "public"."provider" USING "provider"::"public"."provider";--> statement-breakpoint
ALTER TABLE "auth_providers" ADD COLUMN "provider" "provider" NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "login_attempt_unique_idx" ON "login_attempts" USING btree ("identifier","provider","login_type");--> statement-breakpoint
CREATE INDEX "login_attempt_provider_idx" ON "login_attempts" USING btree ("provider");--> statement-breakpoint
CREATE INDEX "login_attempt_blocked_until_idx" ON "login_attempts" USING btree ("blocked_until");--> statement-breakpoint
CREATE UNIQUE INDEX "auth_provider_unique_idx" ON "auth_providers" USING btree ("provider","provider_user_id");--> statement-breakpoint
ALTER TABLE "auth_providers" DROP COLUMN "provider_type";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "login_attempts";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "blocked_at";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "provider";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "provider_id";