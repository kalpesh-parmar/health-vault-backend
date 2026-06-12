CREATE TYPE "public"."unit" AS ENUM('PILLS', 'ML', 'DROPS', 'UNITS');--> statement-breakpoint
CREATE TYPE "public"."frequency" AS ENUM('ONCE_DAILY', 'TWICE_DAILY', 'THREE_TIMES_DAILY', 'AS_NEEDED');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('PENDING', 'COMPLETED');--> statement-breakpoint
CREATE TABLE "medication_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"dose_per_intake" integer,
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
	"completed_at" timestamp,
	"is_overdue" boolean DEFAULT false,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refill_count" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"before_refill_total_quantity" integer NOT NULL,
	"before_refill_remaining_quantity" integer NOT NULL,
	"refill_quantity" integer NOT NULL,
	"after_refill_total_quantity" integer NOT NULL,
	"after_refill_remaining_quantity" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "medications" RENAME COLUMN "medication_times" TO "medication_schedule";--> statement-breakpoint
ALTER TABLE "patients" RENAME COLUMN "age" TO "date_of_birth";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "medication_name" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "food_frequency" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "start_date" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "end_date" SET DATA TYPE timestamp;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "unit" SET DATA TYPE "public"."unit" USING "unit"::"public"."unit";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "reminder_before_minutes" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "reminder_before_minutes" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "profile_image_key" SET DATA TYPE varchar(500);--> statement-breakpoint
ALTER TABLE "medication_reminders" ADD CONSTRAINT "medication_reminders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminders" ADD CONSTRAINT "medication_reminders_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_reminder_id_medication_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."medication_reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_count" ADD CONSTRAINT "refill_count_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refill_count" ADD CONSTRAINT "refill_count_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medication_reminders_patient_idx" ON "medication_reminders" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "medication_reminders_medication_idx" ON "medication_reminders" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "occurrence_reminder_idx" ON "medication_reminder_occurrences" USING btree ("reminder_id");--> statement-breakpoint
CREATE INDEX "medication_reminder_occurrences_patient_id_idx" ON "medication_reminder_occurrences" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "occurrence_medication_idx" ON "medication_reminder_occurrences" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "occurrence_status_idx" ON "medication_reminder_occurrences" USING btree ("status");--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "best_taken";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "remaining_quantity";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "dose_reminders";--> statement-breakpoint
ALTER TABLE "medications" DROP COLUMN "refill_alert";--> statement-breakpoint
ALTER TABLE "patients" DROP COLUMN "user_name";