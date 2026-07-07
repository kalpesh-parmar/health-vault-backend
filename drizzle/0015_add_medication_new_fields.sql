ALTER TYPE "medication_type" ADD VALUE IF NOT EXISTS 'DROPS';--> statement-breakpoint
ALTER TYPE "medication_type" ADD VALUE IF NOT EXISTS 'SPRAY';--> statement-breakpoint
ALTER TYPE "medication_type" ADD VALUE IF NOT EXISTS 'INHALER';--> statement-breakpoint

ALTER TYPE "unit" ADD VALUE IF NOT EXISTS 'TABLET';--> statement-breakpoint
ALTER TYPE "unit" ADD VALUE IF NOT EXISTS 'CAPSULE';--> statement-breakpoint
ALTER TYPE "unit" ADD VALUE IF NOT EXISTS 'TSP';--> statement-breakpoint
ALTER TYPE "unit" ADD VALUE IF NOT EXISTS 'TBSP';--> statement-breakpoint
ALTER TYPE "unit" ADD VALUE IF NOT EXISTS 'IU';--> statement-breakpoint
ALTER TYPE "unit" ADD VALUE IF NOT EXISTS 'PUFF';--> statement-breakpoint

DROP TABLE IF EXISTS "medications" CASCADE;--> statement-breakpoint

CREATE TABLE "medications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"patient_code" varchar(32) NOT NULL,
	"medication_name" varchar(255) NOT NULL,
	"medication_type" "medication_type" NOT NULL,
	"prescribed_by" varchar(255),
	"dose_per_intake" integer,
	"frequency" "frequency_type" NOT NULL,
	"medication_schedule" json NOT NULL,
	"food_frequency" "food_type" NOT NULL,
	"start_date" timestamp NOT NULL,
	"end_date" timestamp,
	"ongoing" boolean DEFAULT false NOT NULL,
	"total_quantity" integer DEFAULT 0,
	"unit" "unit" NOT NULL,
	"daily_consumption" integer DEFAULT 0 NOT NULL,
	"reminder_before_minutes" integer DEFAULT 5,
	"notes" varchar(1000),
	"client_med_id" varchar(255),
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	"soft_delete" boolean DEFAULT false NOT NULL,
	CONSTRAINT "medications_user_client_med_id_uniq" UNIQUE("user_id","client_med_id")
);--> statement-breakpoint

ALTER TABLE "medications" ADD CONSTRAINT "medications_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medications_patient_code_idx" ON "medications" USING btree ("patient_code");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medications_name_idx" ON "medications" USING btree ("medication_name");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "medications_start_date_idx" ON "medications" USING btree ("start_date");
