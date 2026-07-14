-- 1. Add column with default
ALTER TABLE "patients" ADD COLUMN "preferred_language" varchar(50) DEFAULT 'english';

-- 2. Backfill preferred_language from user_onboarding
-- Confirmed Join Column: patients.id is the primary key and maps directly to user_onboarding.user_id
UPDATE "patients" p
SET "preferred_language" = COALESCE(
  u.data->>'preferredLanguage',
  'english'
)
FROM "user_onboarding" u
WHERE p.id = u.user_id;
