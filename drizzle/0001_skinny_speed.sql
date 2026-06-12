CREATE TYPE "public"."document_type" AS ENUM('family', 'medical_document', 'medication', 'insurance', 'other');--> statement-breakpoint
CREATE TYPE "public"."file_type" AS ENUM('application/document', 'image/jpeg', 'application/pdf', 'image/png', 'text/plain');--> statement-breakpoint
CREATE TYPE "public"."ocr_status" AS ENUM('completed', 'failed', 'in_progress', 'pending');--> statement-breakpoint
CREATE TYPE "public"."medication_type" AS ENUM('TABLET', 'CAPSULE', 'SYRUP', 'DROP', 'INJECTION');--> statement-breakpoint
CREATE TYPE "public"."frequency_type" AS ENUM('ONCE_DAILY', 'TWICE_DAILY', 'THREE_TIMES_DAILY', 'AS_NEEDED');--> statement-breakpoint
CREATE TYPE "public"."food_type" AS ENUM('BEFORE_FOOD', 'AFTER_FOOD');--> statement-breakpoint
CREATE TYPE "public"."frequency" AS ENUM('ONCE_DAILY', 'TWICE_DAILY', 'THREE_TIMES_DAILY', 'AS_NEEDED');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('PENDING', 'COMPLETED');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'BLOCKED', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('female', 'male');--> statement-breakpoint
CREATE TABLE "documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_type" "document_type" NOT NULL,
	"file_name" varchar(255) NOT NULL,
	"file_path" text NOT NULL,
	"s3_bucket" varchar(255),
	"s3_key" varchar(500),
	"file_type" "file_type" NOT NULL,
	"file_size" integer NOT NULL,
	"ocr_status" "ocr_status" DEFAULT 'pending',
	"ocr_extracted_text" text,
	"structured_extracted_data" text,
	"report_date" date,
	"hospital_name" varchar(255),
	"doctor_name" varchar(255),
	"remarks" text,
	"soft_delete" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"patient_code" varchar(32) NOT NULL,
	"medication_name" text NOT NULL,
	"medication_type" "medication_type" NOT NULL,
	"prescribed_by" varchar(255),
	"dose_per_intake" integer,
	"frequency" "frequency_type" NOT NULL,
	"medication_times" json,
	"best_taken" "best_taken" NOT NULL,
	"food_frequency" "food_type" NOT NULL,
	"start_date" date NOT NULL,
	"end_date" date,
	"ongoing" boolean DEFAULT false NOT NULL,
	"total_quantity" integer DEFAULT 0,
	"remaining_quantity" integer DEFAULT 0,
	"dose_reminders" boolean DEFAULT false,
	"unit" "unit" NOT NULL,
	"daily_consumption" integer DEFAULT 0 NOT NULL,
	"refill_alert" boolean DEFAULT false,
	"is_reminder" boolean DEFAULT false,
	"reminder_before_minutes" integer DEFAULT 5 NOT NULL,
	"notes" varchar(1000),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medication_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"reminder_before_minutes" integer DEFAULT 5 NOT NULL,
	"after_reminder_minutes" integer DEFAULT 10 NOT NULL,
	"refill_alert_before_days" integer DEFAULT 2 NOT NULL,
	"dose_per_intake" integer,
	"frequency" "frequency" DEFAULT 'ONCE_DAILY' NOT NULL,
	"medication_times" json,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medication_reminder_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"status" "occurrence_status" DEFAULT 'PENDING' NOT NULL,
	"actual_medication_time" timestamp NOT NULL,
	"before_reminder_time" timestamp,
	"after_reminder_time" timestamp,
	"notification_sent" boolean DEFAULT false NOT NULL,
	"notification_sent_at" timestamp,
	"completed_at" timestamp,
	"is_follow_up" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" varchar(255) NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"data" jsonb,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_code" varchar(32) NOT NULL,
	"first_name" varchar(255) NOT NULL,
	"last_name" varchar(255) NOT NULL,
	"full_name" varchar(255) NOT NULL,
	"email" varchar(255) NOT NULL,
	"password" varchar(255) NOT NULL,
	"status" "user_status" DEFAULT 'ACTIVE' NOT NULL,
	"login_attempts" integer DEFAULT 0 NOT NULL,
	"blocked_at" timestamp,
	"otp" varchar(10),
	"otp_send_date_time" timestamp,
	"otp_expired_date_time" timestamp,
	"is_verified" boolean DEFAULT false NOT NULL,
	"otp_verified_at" timestamp,
	"gender" "gender" NOT NULL,
	"date_of_birth" date NOT NULL,
	"phone" varchar(20) NOT NULL,
	"profile_image_key" varchar(500),
	"soft_delete" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "patients_patient_code_unique" UNIQUE("patient_code"),
	CONSTRAINT "patients_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"refresh_token_hash" varchar(255) NOT NULL,
	"refresh_token_expires_at" timestamp NOT NULL,
	"login_time" timestamp DEFAULT now() NOT NULL,
	"logout_time" timestamp,
	"device_token" varchar(500),
	"is_active" boolean DEFAULT true NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medications" ADD CONSTRAINT "medications_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminders" ADD CONSTRAINT "medication_reminders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminders" ADD CONSTRAINT "medication_reminders_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_reminder_id_medication_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."medication_reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_type_idx" ON "documents" USING btree ("document_type");--> statement-breakpoint
CREATE INDEX "documents_soft_delete_idx" ON "documents" USING btree ("soft_delete");--> statement-breakpoint
CREATE INDEX "documents_report_date_idx" ON "documents" USING btree ("report_date");--> statement-breakpoint
CREATE INDEX "documents_created_at_idx" ON "documents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "medications_patient_code_idx" ON "medications" USING btree ("patient_code");--> statement-breakpoint
CREATE INDEX "medications_name_idx" ON "medications" USING btree ("medication_name");--> statement-breakpoint
CREATE INDEX "medications_start_date_idx" ON "medications" USING btree ("start_date");--> statement-breakpoint
CREATE INDEX "medication_reminders_patient_idx" ON "medication_reminders" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "medication_reminders_medication_idx" ON "medication_reminders" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "occurrence_reminder_idx" ON "medication_reminder_occurrences" USING btree ("reminder_id");--> statement-breakpoint
CREATE INDEX "medication_reminder_occurrences_patient_id_idx" ON "medication_reminder_occurrences" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "occurrence_medication_idx" ON "medication_reminder_occurrences" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "occurrence_status_idx" ON "medication_reminder_occurrences" USING btree ("status");--> statement-breakpoint
CREATE INDEX "before_reminder_idx" ON "medication_reminder_occurrences" USING btree ("before_reminder_time");--> statement-breakpoint
CREATE INDEX "after_reminder_idx" ON "medication_reminder_occurrences" USING btree ("after_reminder_time");--> statement-breakpoint
CREATE INDEX "notifications_user_id_idx" ON "notifications" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "notifications_is_read_idx" ON "notifications" USING btree ("is_read");--> statement-breakpoint
CREATE INDEX "notifications_created_at_idx" ON "notifications" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_email_unique_idx" ON "patients" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_code_unique_idx" ON "patients" USING btree ("patient_code");--> statement-breakpoint
CREATE INDEX "patients_status_idx" ON "patients" USING btree ("status");--> statement-breakpoint
CREATE INDEX "patients_soft_delete_idx" ON "patients" USING btree ("soft_delete");--> statement-breakpoint
CREATE INDEX "patients_email_idx" ON "patients" USING btree ("email");--> statement-breakpoint
CREATE INDEX "patients_full_name_idx" ON "patients" USING btree ("full_name");--> statement-breakpoint
CREATE INDEX "patients_phone_idx" ON "patients" USING btree ("phone");--> statement-breakpoint
CREATE INDEX "patients_created_at_idx" ON "patients" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_refresh_token_hash_idx" ON "sessions" USING btree ("refresh_token_hash");--> statement-breakpoint
CREATE INDEX "sessions_is_active_idx" ON "sessions" USING btree ("is_active");--> statement-breakpoint
CREATE INDEX "sessions_soft_delete_idx" ON "sessions" USING btree ("soft_delete");