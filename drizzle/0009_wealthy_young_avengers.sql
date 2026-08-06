DROP TABLE "user_sessions" CASCADE;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "refresh_token" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "device_info" text;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "ip_address" varchar(45);--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "expires_at" timestamp;--> statement-breakpoint
ALTER TABLE "sessions" ADD COLUMN "is_revoked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "otp";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "otp_send_date_time";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "otp_expired_date_time";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "otp_verified_at";