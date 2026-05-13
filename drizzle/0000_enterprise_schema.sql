CREATE EXTENSION IF NOT EXISTS "pgcrypto";

DO $$ BEGIN
  CREATE TYPE "gender" AS ENUM ('female', 'male');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "user_status" AS ENUM ('ACTIVE', 'BLOCKED', 'INACTIVE');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "document_type" AS ENUM ('family', 'medical_document', 'medication', 'insurance', 'other');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "file_type" AS ENUM ('application/document', 'image/jpeg', 'application/pdf', 'image/png', 'text/plain');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE "ocr_status" AS ENUM ('completed', 'failed', 'in_progress', 'pending');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "patients" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "patient_code" varchar(32) NOT NULL UNIQUE,
  "user_name" varchar(255) NOT NULL,
  "first_name" varchar(255) NOT NULL,
  "last_name" varchar(255) NOT NULL,
  "full_name" varchar(255),
  "email" varchar(255) NOT NULL UNIQUE,
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
  "date_of_birth" date,
  "age" integer NOT NULL,
  "phone" varchar(20) NOT NULL,
  "profile_image_key" varchar(500),
  "soft_delete" boolean DEFAULT false NOT NULL,
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS "sessions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "patients"("id") ON DELETE cascade,
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

CREATE TABLE IF NOT EXISTS "documents" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "patients"("id") ON DELETE cascade,
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

CREATE TABLE IF NOT EXISTS "health_records" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "patients"("id") ON DELETE cascade,
  "record" text,
  "soft_delete" boolean DEFAULT false NOT NULL,
  "deleted_at" timestamp,
  "created_at" timestamp DEFAULT now() NOT NULL,
  "updated_at" timestamp DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "patients_status_idx" ON "patients" ("status");
CREATE INDEX IF NOT EXISTS "patients_soft_delete_idx" ON "patients" ("soft_delete");
CREATE INDEX IF NOT EXISTS "patients_email_idx" ON "patients" ("email");
CREATE INDEX IF NOT EXISTS "patients_full_name_idx" ON "patients" ("full_name");
CREATE INDEX IF NOT EXISTS "patients_phone_idx" ON "patients" ("phone");
CREATE INDEX IF NOT EXISTS "patients_created_at_idx" ON "patients" ("created_at");
CREATE INDEX IF NOT EXISTS "sessions_user_id_idx" ON "sessions" ("user_id");
CREATE INDEX IF NOT EXISTS "sessions_refresh_token_hash_idx" ON "sessions" ("refresh_token_hash");
CREATE INDEX IF NOT EXISTS "sessions_is_active_idx" ON "sessions" ("is_active");
CREATE INDEX IF NOT EXISTS "sessions_soft_delete_idx" ON "sessions" ("soft_delete");
CREATE INDEX IF NOT EXISTS "documents_user_id_idx" ON "documents" ("user_id");
CREATE INDEX IF NOT EXISTS "documents_type_idx" ON "documents" ("document_type");
CREATE INDEX IF NOT EXISTS "documents_soft_delete_idx" ON "documents" ("soft_delete");
CREATE INDEX IF NOT EXISTS "documents_report_date_idx" ON "documents" ("report_date");
CREATE INDEX IF NOT EXISTS "documents_created_at_idx" ON "documents" ("created_at");
CREATE INDEX IF NOT EXISTS "health_records_user_id_idx" ON "health_records" ("user_id");
CREATE INDEX IF NOT EXISTS "health_records_soft_delete_idx" ON "health_records" ("soft_delete");
