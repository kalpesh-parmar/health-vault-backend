ALTER TABLE "chat_messages" ADD COLUMN "seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "patients" ADD COLUMN "preferred_language" varchar(50) DEFAULT 'english';