ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "after_notification_sent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "after_notification_sent_at" timestamp;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "overdue_notification_sent" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "medication_reminder_occurrences" ADD COLUMN "overdue_notification_sent_at" timestamp;