ALTER TABLE "chat_history" DISABLE ROW LEVEL SECURITY;--> statement-breakpoint
DROP TABLE "chat_history" CASCADE;--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_document_id_documents_id_fk";
--> statement-breakpoint
DROP INDEX "chat_sessions_document_id_idx";--> statement-breakpoint
ALTER TABLE "medications" ALTER COLUMN "dose_per_intake" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "medication_reminders" ALTER COLUMN "dose_per_intake" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "chat_sessions" DROP COLUMN "document_id";