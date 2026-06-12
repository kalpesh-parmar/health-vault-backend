CREATE TYPE "public"."document_type" AS ENUM('family', 'medical_document', 'medication', 'insurance', 'other');--> statement-breakpoint
CREATE TYPE "public"."file_type" AS ENUM('application/document', 'image/jpeg', 'application/pdf', 'image/png', 'text/plain', 'image/jpg');--> statement-breakpoint
CREATE TYPE "public"."ocr_status" AS ENUM('completed', 'failed', 'in_progress', 'pending');--> statement-breakpoint
CREATE TYPE "public"."ai_source_type" AS ENUM('ocr_chunk', 'summary', 'profile', 'reminder', 'medication', 'report', 'chat');--> statement-breakpoint
CREATE TYPE "public"."medical_entity_type" AS ENUM('medicine', 'dosage', 'blood_group', 'allergy', 'disease', 'test_value', 'abnormal_value', 'doctor_name', 'date', 'follow_up_instruction', 'other');--> statement-breakpoint
CREATE TYPE "public"."medication_type" AS ENUM('TABLET', 'CAPSULE', 'SYRUP', 'DROP', 'INJECTION');--> statement-breakpoint
CREATE TYPE "public"."frequency_type" AS ENUM('ONCE_DAILY', 'TWICE_DAILY', 'THREE_TIMES_DAILY', 'AS_NEEDED');--> statement-breakpoint
CREATE TYPE "public"."food_type" AS ENUM('BEFORE_FOOD', 'AFTER_FOOD');--> statement-breakpoint
CREATE TYPE "public"."user_status" AS ENUM('ACTIVE', 'BLOCKED', 'INACTIVE');--> statement-breakpoint
CREATE TYPE "public"."gender" AS ENUM('female', 'male');--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"session_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" varchar(16) NOT NULL,
	"content" text NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid,
	"title" varchar(255),
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"last_message_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
	"structured_extracted_data" jsonb,
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
CREATE TABLE "document_ai_summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"hospital_name" varchar(255),
	"doctor_name" varchar(255),
	"patient_name" varchar(255),
	"report_type" varchar(128),
	"report_date" timestamp,
	"diagnosis" text,
	"observations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"recommendations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"medications" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"allergies" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blood_group" varchar(8),
	"test_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"summary" text,
	"ai_model" varchar(128),
	"ai_provider" varchar(32),
	"raw_ai_response" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "document_ai_summary_document_id_unique" UNIQUE("document_id")
);
--> statement-breakpoint
CREATE TABLE "document_ocr_raw_data" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"file_key" varchar(500) NOT NULL,
	"engine" varchar(32) NOT NULL,
	"language" varchar(32),
	"page_count" integer DEFAULT 0 NOT NULL,
	"full_text" text,
	"tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"confidence" numeric(5, 4),
	"used_direct_text" boolean DEFAULT false NOT NULL,
	"used_ocr" boolean DEFAULT false NOT NULL,
	"processing_seconds" numeric(8, 3),
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "document_ocr_raw_data_document_id_unique" UNIQUE("document_id")
);
--> statement-breakpoint
CREATE TABLE "document_pages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"page_number" integer NOT NULL,
	"raw_text" text,
	"confidence" numeric(5, 4),
	"blocks" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medical_graphs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"graph_type" varchar(64) NOT NULL,
	"title" varchar(255),
	"x_axis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"y_axis" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"series" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"unit" varchar(64),
	"page" integer,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_context_cache" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"cache_key" varchar(255) NOT NULL,
	"context" jsonb NOT NULL,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid,
	"session_id" varchar(128),
	"user_message" text NOT NULL,
	"ai_response" jsonb NOT NULL,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_chunks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid,
	"structured_document_id" uuid,
	"user_id" uuid NOT NULL,
	"source_type" "ai_source_type" DEFAULT 'ocr_chunk' NOT NULL,
	"chunk_index" integer NOT NULL,
	"section_title" varchar(255),
	"content" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"token_estimate" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"chunk_id" uuid,
	"source_type" "ai_source_type" NOT NULL,
	"source_id" uuid,
	"embedding" vector(384) NOT NULL,
	"model" varchar(128) NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medical_entities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid,
	"structured_document_id" uuid,
	"entity_type" "medical_entity_type" NOT NULL,
	"name" varchar(255) NOT NULL,
	"value" text,
	"unit" varchar(64),
	"normal_range" varchar(255),
	"is_abnormal" boolean DEFAULT false NOT NULL,
	"confidence" integer,
	"source_text" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "structured_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"document_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"schema_version" varchar(32) DEFAULT '2026-01' NOT NULL,
	"language" varchar(32),
	"page_count" integer DEFAULT 0 NOT NULL,
	"sections" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"paragraphs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tables" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"forms" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"prescriptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"lab_reports" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"medical_entities" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"raw_ocr" jsonb,
	"confidence" integer,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "document_processing_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"file_key" varchar(500) NOT NULL,
	"user_id" uuid NOT NULL,
	"status" varchar(16) DEFAULT 'QUEUED' NOT NULL,
	"stage" varchar(64),
	"percentage" integer DEFAULT 0,
	"current_step" varchar(255),
	"completed_steps" integer DEFAULT 0,
	"pending_steps" integer DEFAULT 0,
	"message" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw_ocr_data" jsonb,
	"extracted_structured_data" jsonb,
	"graphs" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"error" text,
	"started_at" timestamp,
	"completed_at" timestamp,
	"expires_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"patient_code" varchar(32) NOT NULL,
	"medication_name" varchar(255) NOT NULL,
	"medication_type" "medication_type" NOT NULL,
	"prescribed_by" varchar(255),
	"dose_per_intake" integer,
	"frequency" "frequency_type" NOT NULL,
	"medication_times" json,
	"best_taken" varchar(50)[],
	"food_frequency" "food_type",
	"start_date" date NOT NULL,
	"end_date" date,
	"ongoing" boolean DEFAULT false NOT NULL,
	"total_quantity" integer DEFAULT 0,
	"remaining_quantity" integer DEFAULT 0,
	"dose_reminders" boolean DEFAULT false,
	"unit" varchar(20) NOT NULL,
	"daily_consumption" integer DEFAULT 0 NOT NULL,
	"refill_alert" boolean DEFAULT false,
	"reminder_before_minutes" integer DEFAULT 5 NOT NULL,
	"notes" varchar(1000),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
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
	"user_name" varchar(255) NOT NULL,
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
	"age" integer NOT NULL,
	"phone" varchar(20) NOT NULL,
	"profile_image_key" text,
	"blood_group" varchar(8),
	"allergies" text[],
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
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_session_id_chat_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."chat_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_sessions" ADD CONSTRAINT "chat_sessions_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "documents" ADD CONSTRAINT "documents_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_ai_summary" ADD CONSTRAINT "document_ai_summary_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_ai_summary" ADD CONSTRAINT "document_ai_summary_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_ocr_raw_data" ADD CONSTRAINT "document_ocr_raw_data_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_ocr_raw_data" ADD CONSTRAINT "document_ocr_raw_data_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_pages" ADD CONSTRAINT "document_pages_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_graphs" ADD CONSTRAINT "medical_graphs_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_graphs" ADD CONSTRAINT "medical_graphs_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_context_cache" ADD CONSTRAINT "ai_context_cache_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_history" ADD CONSTRAINT "chat_history_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_history" ADD CONSTRAINT "chat_history_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_structured_document_id_structured_documents_id_fk" FOREIGN KEY ("structured_document_id") REFERENCES "public"."structured_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_chunks" ADD CONSTRAINT "document_chunks_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "embeddings" ADD CONSTRAINT "embeddings_chunk_id_document_chunks_id_fk" FOREIGN KEY ("chunk_id") REFERENCES "public"."document_chunks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_entities" ADD CONSTRAINT "medical_entities_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_entities" ADD CONSTRAINT "medical_entities_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medical_entities" ADD CONSTRAINT "medical_entities_structured_document_id_structured_documents_id_fk" FOREIGN KEY ("structured_document_id") REFERENCES "public"."structured_documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structured_documents" ADD CONSTRAINT "structured_documents_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "structured_documents" ADD CONSTRAINT "structured_documents_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "document_processing_jobs" ADD CONSTRAINT "document_processing_jobs_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medications" ADD CONSTRAINT "medications_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "chat_messages_session_idx" ON "chat_messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE INDEX "chat_messages_user_id_idx" ON "chat_messages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_messages_created_at_idx" ON "chat_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_user_id_idx" ON "chat_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_document_id_idx" ON "chat_sessions" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chat_sessions_last_message_at_idx" ON "chat_sessions" USING btree ("user_id","last_message_at");--> statement-breakpoint
CREATE INDEX "chat_sessions_soft_delete_idx" ON "chat_sessions" USING btree ("soft_delete");--> statement-breakpoint
CREATE INDEX "documents_user_id_idx" ON "documents" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "documents_type_idx" ON "documents" USING btree ("document_type");--> statement-breakpoint
CREATE INDEX "documents_soft_delete_idx" ON "documents" USING btree ("soft_delete");--> statement-breakpoint
CREATE INDEX "documents_report_date_idx" ON "documents" USING btree ("report_date");--> statement-breakpoint
CREATE INDEX "documents_created_at_idx" ON "documents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "document_ai_summary_user_id_idx" ON "document_ai_summary" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_ai_summary_report_type_idx" ON "document_ai_summary" USING btree ("report_type");--> statement-breakpoint
CREATE INDEX "document_ai_summary_report_date_idx" ON "document_ai_summary" USING btree ("report_date");--> statement-breakpoint
CREATE INDEX "document_ocr_raw_data_user_id_idx" ON "document_ocr_raw_data" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_ocr_raw_data_file_key_idx" ON "document_ocr_raw_data" USING btree ("file_key");--> statement-breakpoint
CREATE INDEX "document_pages_document_id_idx" ON "document_pages" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_pages_user_id_idx" ON "document_pages" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_pages_page_number_idx" ON "document_pages" USING btree ("document_id","page_number");--> statement-breakpoint
CREATE INDEX "medical_graphs_document_id_idx" ON "medical_graphs" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "medical_graphs_user_id_idx" ON "medical_graphs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "medical_graphs_graph_type_idx" ON "medical_graphs" USING btree ("graph_type");--> statement-breakpoint
CREATE INDEX "ai_context_cache_user_id_idx" ON "ai_context_cache" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "ai_context_cache_key_idx" ON "ai_context_cache" USING btree ("cache_key");--> statement-breakpoint
CREATE INDEX "chat_history_user_id_idx" ON "chat_history" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "chat_history_document_id_idx" ON "chat_history" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "chat_history_session_id_idx" ON "chat_history" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "chat_history_created_at_idx" ON "chat_history" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "document_chunks_user_id_idx" ON "document_chunks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_chunks_document_id_idx" ON "document_chunks" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "document_chunks_source_type_idx" ON "document_chunks" USING btree ("source_type");--> statement-breakpoint
CREATE INDEX "embeddings_user_id_idx" ON "embeddings" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "embeddings_source_idx" ON "embeddings" USING btree ("source_type","source_id");--> statement-breakpoint
CREATE INDEX "medical_entities_user_id_idx" ON "medical_entities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "medical_entities_document_id_idx" ON "medical_entities" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "medical_entities_type_idx" ON "medical_entities" USING btree ("entity_type");--> statement-breakpoint
CREATE INDEX "medical_entities_name_idx" ON "medical_entities" USING btree ("name");--> statement-breakpoint
CREATE INDEX "structured_documents_document_id_idx" ON "structured_documents" USING btree ("document_id");--> statement-breakpoint
CREATE INDEX "structured_documents_user_id_idx" ON "structured_documents" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "document_processing_jobs_file_key_key" ON "document_processing_jobs" USING btree ("file_key");--> statement-breakpoint
CREATE INDEX "document_processing_jobs_user_id_idx" ON "document_processing_jobs" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "document_processing_jobs_status_idx" ON "document_processing_jobs" USING btree ("status");--> statement-breakpoint
CREATE INDEX "document_processing_jobs_expires_at_idx" ON "document_processing_jobs" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "medications_patient_code_idx" ON "medications" USING btree ("patient_code");--> statement-breakpoint
CREATE INDEX "medications_name_idx" ON "medications" USING btree ("medication_name");--> statement-breakpoint
CREATE INDEX "medications_start_date_idx" ON "medications" USING btree ("start_date");--> statement-breakpoint
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