-- Step 1: Pre-migration data safety verification and backfill
-- Ensure that any historical records in document_ai_summary are represented in documents.structured_extracted_data if structured_extracted_data is currently null
UPDATE "documents" d
SET "structured_extracted_data" = jsonb_build_object(
    'documentInfo', jsonb_build_object('documentType', COALESCE(s.report_type, 'MEDICAL_REPORT'), 'documentDate', s.report_date),
    'patientInfo', jsonb_build_object('fullName', s.patient_name),
    'providerInfo', jsonb_build_object('primary', jsonb_build_object('name', s.doctor_name), 'providers', CASE WHEN s.doctor_name IS NOT NULL THEN jsonb_build_array(jsonb_build_object('name', s.doctor_name, 'isPrimary', true)) ELSE '[]'::jsonb END),
    'facilityInfo', jsonb_build_object('name', s.hospital_name),
    'diagnosis', CASE WHEN s.diagnosis IS NOT NULL AND s.diagnosis != '' THEN jsonb_build_array(jsonb_build_object('condition', s.diagnosis)) ELSE '[]'::jsonb END,
    'medications', COALESCE(s.medications, '[]'::jsonb),
    'labResults', COALESCE(s.test_results, '[]'::jsonb),
    'additionalInformation', jsonb_build_object('recommendations', COALESCE(s.recommendations, '[]'::jsonb), 'observations', COALESCE(s.observations, '[]'::jsonb))
)
FROM "document_ai_summary" s
WHERE d.id = s.document_id AND d.structured_extracted_data IS NULL;--> statement-breakpoint

-- Step 2: Drop unused indexes on dropped columns
DROP INDEX IF EXISTS "document_ai_summary_report_type_idx";--> statement-breakpoint
DROP INDEX IF EXISTS "document_ai_summary_report_date_idx";--> statement-breakpoint

-- Step 3: Safely drop duplicate medical data columns from document_ai_summary
ALTER TABLE "document_ai_summary"
    DROP COLUMN IF EXISTS "hospital_name",
    DROP COLUMN IF EXISTS "doctor_name",
    DROP COLUMN IF EXISTS "patient_name",
    DROP COLUMN IF EXISTS "report_type",
    DROP COLUMN IF EXISTS "report_date",
    DROP COLUMN IF EXISTS "diagnosis",
    DROP COLUMN IF EXISTS "observations",
    DROP COLUMN IF EXISTS "recommendations",
    DROP COLUMN IF EXISTS "medications",
    DROP COLUMN IF EXISTS "allergies",
    DROP COLUMN IF EXISTS "blood_group",
    DROP COLUMN IF EXISTS "test_results",
    DROP COLUMN IF EXISTS "summary";
