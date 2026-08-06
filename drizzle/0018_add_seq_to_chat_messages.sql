ALTER TABLE "chat_messages" ADD COLUMN "seq" integer;--> statement-breakpoint

UPDATE "chat_messages" m
SET "seq" = sub.rn
FROM (
  SELECT id, ROW_NUMBER() OVER (PARTITION BY session_id ORDER BY created_at, id) as rn
  FROM "chat_messages"
) sub
WHERE m.id = sub.id;--> statement-breakpoint

ALTER TABLE "chat_messages" ALTER COLUMN "seq" SET DEFAULT 0;--> statement-breakpoint
ALTER TABLE "chat_messages" ALTER COLUMN "seq" SET NOT NULL;
