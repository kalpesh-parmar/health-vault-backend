ALTER TABLE "documents" ALTER COLUMN "report_date" SET DATA TYPE date;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "dose_per_intake" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "medication_reminders" ALTER COLUMN "dose_per_intake" SET DATA TYPE double precision;