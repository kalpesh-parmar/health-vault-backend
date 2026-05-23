CREATE TYPE "public"."reminder_type" AS ENUM('BEFORE_MEDICATION', 'AFTER_MEDICATION', 'REFILL_ALERT');--> statement-breakpoint
CREATE TYPE "public"."reminder_status" AS ENUM('ACTIVE', 'PAUSED', 'STOPPED');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('PENDING', 'SENT', 'COMPLETED', 'MISSED', 'SKIPPED', 'SNOOZED');--> statement-breakpoint
CREATE TYPE "public"."occurrence_type" AS ENUM('BEFORE_MEDICATION', 'AFTER_MEDICATION', 'REFILL_ALERT');--> statement-breakpoint
CREATE TABLE "medication_reminders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"patient_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
	"type" "reminder_type" NOT NULL,
	"status" "reminder_status" DEFAULT 'ACTIVE' NOT NULL,
	"reminder_before_minutes" integer DEFAULT 5 NOT NULL,
	"after_reminder_minutes" integer DEFAULT 10 NOT NULL,
	"refill_alert_before_days" integer DEFAULT 2 NOT NULL,
	"dose_per_intake" integer,
	"frequency" varchar(50),
	"medication_times" json,
	"timezone" varchar(100) DEFAULT 'Asia/Kolkata' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE "medication_reminder_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid NOT NULL,
	"type" "occurrence_type" NOT NULL,
	"status" "occurrence_status" DEFAULT 'PENDING' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"actual_medication_time" timestamp with time zone,
	"notification_sent" boolean DEFAULT false NOT NULL,
	"notification_sent_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"skipped_at" timestamp with time zone,
	"missed_at" timestamp with time zone,
	"snooze_until" timestamp with time zone,
	"snooze_count" integer DEFAULT 0 NOT NULL,
	"response_message" varchar(500),
	"quantity_consumed" integer DEFAULT 0,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL
);
--> statement-breakpoint
ALTER TABLE "medication_reminders" ADD CONSTRAINT "medication_reminders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminders" ADD CONSTRAINT "medication_reminders_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_reminder_id_medication_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."medication_reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medication_reminders_patient_idx" ON "medication_reminders" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "medication_reminders_medication_idx" ON "medication_reminders" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "medication_reminders_type_idx" ON "medication_reminders" USING btree ("type");--> statement-breakpoint
CREATE INDEX "occurrence_reminder_idx" ON "medication_reminder_occurrences" USING btree ("reminder_id");--> statement-breakpoint
CREATE INDEX "occurrence_status_idx" ON "medication_reminder_occurrences" USING btree ("status");--> statement-breakpoint
CREATE INDEX "occurrence_schedule_idx" ON "medication_reminder_occurrences" USING btree ("scheduled_at");