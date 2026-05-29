CREATE TYPE "public"."frequency" AS ENUM('ONCE_DAILY', 'TWICE_DAILY', 'THREE_TIMES_DAILY', 'AS_NEEDED');--> statement-breakpoint
CREATE TYPE "public"."occurrence_status" AS ENUM('PENDING', 'COMPLETED');--> statement-breakpoint
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
ALTER TABLE "medication_reminders" ADD CONSTRAINT "medication_reminders_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminders" ADD CONSTRAINT "medication_reminders_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_reminder_id_medication_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."medication_reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_patient_id_patients_id_fk" FOREIGN KEY ("patient_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "medication_reminders_patient_idx" ON "medication_reminders" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "medication_reminders_medication_idx" ON "medication_reminders" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "occurrence_reminder_idx" ON "medication_reminder_occurrences" USING btree ("reminder_id");--> statement-breakpoint
CREATE INDEX "medication_reminder_occurrences_patient_id_idx" ON "medication_reminder_occurrences" USING btree ("patient_id");--> statement-breakpoint
CREATE INDEX "occurrence_medication_idx" ON "medication_reminder_occurrences" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "occurrence_status_idx" ON "medication_reminder_occurrences" USING btree ("status");--> statement-breakpoint
CREATE INDEX "before_reminder_idx" ON "medication_reminder_occurrences" USING btree ("before_reminder_time");--> statement-breakpoint
CREATE INDEX "after_reminder_idx" ON "medication_reminder_occurrences" USING btree ("after_reminder_time");