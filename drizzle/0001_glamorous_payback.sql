CREATE TYPE "public"."medication_type" AS ENUM('TABLET', 'CAPSULE', 'SYRUP', 'DROP', 'INJECTION');--> statement-breakpoint
CREATE TYPE "public"."frequency_type" AS ENUM('ONCE_DAILY', 'TWICE_DAILY', 'THREE_TIMES_DAILY', 'AS_NEEDED');--> statement-breakpoint
CREATE TYPE "public"."food_type" AS ENUM('BEFORE_FOOD', 'AFTER_FOOD');--> statement-breakpoint
ALTER TYPE "public"."file_type" ADD VALUE 'image/jpg';--> statement-breakpoint
CREATE TABLE "AI_Summary" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"user_message" text,
	"AI_summary_data" jsonb,
	"soft_delete" boolean DEFAULT false NOT NULL,
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
ALTER TABLE "documents" ALTER COLUMN "structured_extracted_data" SET DATA TYPE jsonb;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "profile_image_key" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "AI_Summary" ADD CONSTRAINT "AI_Summary_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medications" ADD CONSTRAINT "medications_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medications_patient_code_idx" ON "medications" USING btree ("patient_code");--> statement-breakpoint
CREATE INDEX "medications_name_idx" ON "medications" USING btree ("medication_name");--> statement-breakpoint
CREATE INDEX "medications_start_date_idx" ON "medications" USING btree ("start_date");