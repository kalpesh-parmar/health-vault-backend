CREATE TYPE "public"."occurrence_status" AS ENUM('PENDING', 'SENT', 'COMPLETED', 'MISSED', 'SKIPPED', 'SNOOZED', 'OVERDUE');--> statement-breakpoint
CREATE TYPE "public"."occurrence_type" AS ENUM('BEFORE_MEDICATION', 'AFTER_MEDICATION', 'REFILL_ALERT');--> statement-breakpoint
CREATE TABLE "medication_reminder_occurrences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reminder_id" uuid NOT NULL,
	"medication_id" uuid NOT NULL,
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
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_reminder_id_medication_reminders_id_fk" FOREIGN KEY ("reminder_id") REFERENCES "public"."medication_reminders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD CONSTRAINT "medication_reminder_occurrences_medication_id_medications_id_fk" FOREIGN KEY ("medication_id") REFERENCES "public"."medications"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "occurrence_reminder_idx" ON "medication_reminder_occurrences" USING btree ("reminder_id");--> statement-breakpoint
CREATE INDEX "occurrence_medication_idx" ON "medication_reminder_occurrences" USING btree ("medication_id");--> statement-breakpoint
CREATE INDEX "occurrence_status_idx" ON "medication_reminder_occurrences" USING btree ("status");--> statement-breakpoint
CREATE INDEX "occurrence_schedule_idx" ON "medication_reminder_occurrences" USING btree ("scheduled_at");