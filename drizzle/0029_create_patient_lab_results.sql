CREATE TABLE IF NOT EXISTS "patient_lab_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"document_id" uuid,
	"report_id" varchar(255),
	"canonical_key" varchar(128) NOT NULL,
	"test_name" varchar(255) NOT NULL,
	"value_numeric" double precision,
	"value_text" text,
	"unit" varchar(64),
	"reference_range" varchar(255),
	"flag" varchar(32) DEFAULT 'NORMAL' NOT NULL,
	"is_abnormal" boolean DEFAULT false NOT NULL,
	"is_critical" boolean DEFAULT false NOT NULL,
	"test_date" timestamp with time zone,
	"page_no" integer DEFAULT 1 NOT NULL,
	"confidence" double precision,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "patient_lab_results" ADD CONSTRAINT "patient_lab_results_user_id_patients_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."patients"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "patient_lab_results" ADD CONSTRAINT "patient_lab_results_document_id_documents_id_fk" FOREIGN KEY ("document_id") REFERENCES "public"."documents"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_lab_results_user_canonical_date_idx" ON "patient_lab_results" USING btree ("user_id","canonical_key","test_date" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_lab_results_document_id_idx" ON "patient_lab_results" USING btree ("document_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_lab_results_user_date_idx" ON "patient_lab_results" USING btree ("user_id","test_date" DESC NULLS LAST);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "patient_lab_results_canonical_key_idx" ON "patient_lab_results" USING btree ("canonical_key");
