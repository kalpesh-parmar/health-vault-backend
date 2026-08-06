ALTER TABLE "AI_Summary" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "AI_Summary" CASCADE;--> statement-breakpoint
ALTER TABLE "embeddings" ALTER COLUMN "embedding" SET DATA TYPE vector(768);--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "medication_name" SET DATA TYPE varchar(255);--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "medication_schedule" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "food_frequency" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "reminder_before_minutes" SET DEFAULT 5;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "date_of_birth" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ALTER COLUMN "profile_image_key" SET DATA TYPE text;--> statement-breakpoint
ALTER TABLE "medications" ADD COLUMN "medication_times" json;--> statement-breakpoint
ALTER TABLE "medications" ADD COLUMN "best_taken" varchar(50)[];--> statement-breakpoint
ALTER TABLE "medications" ADD COLUMN "remaining_quantity" integer DEFAULT 0;--> statement-breakpoint
ALTER TABLE "medications" ADD COLUMN "dose_reminders" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "medications" ADD COLUMN "refill_alert" boolean DEFAULT false;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "user_name" varchar(255) NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "age" integer;