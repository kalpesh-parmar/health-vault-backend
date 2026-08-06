ALTER TABLE "chat_sessions" DROP CONSTRAINT "chat_sessions_document_id_documents_id_fk";
--> statement-breakpoint
ALTER TABLE "chat_sessions" ALTER COLUMN "document_id" SET DATA TYPE jsonb USING CASE WHEN document_id IS NOT NULL THEN jsonb_build_array(document_id) ELSE NULL END;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD COLUMN "seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "preferred_language" varchar(50) DEFAULT 'english';