from __future__ import annotations

from datetime import date, datetime
import json
import logging
import re
from typing import Any, NamedTuple
from uuid import UUID

from sqlalchemy import text

from app.infrastructure.db.session import Database

logger = logging.getLogger(__name__)

CANONICAL_DOCUMENT_TYPES = {
    "PRESCRIPTION",
    "LAB_REPORT",
    "IMAGING_REPORT",
    "DISCHARGE_SUMMARY",
    "CONSULTATION_REPORT",
    "SURGERY_PROCEDURE_REPORT",
    "VACCINATION_RECORD",
    "MEDICAL_CERTIFICATE",
    "OTHER_MEDICAL_DOCUMENT",
}

DOCUMENT_TYPE_ALIAS_MAP = {
    # Prescription
    "prescription": "PRESCRIPTION",
    "prescriptions": "PRESCRIPTION",
    "rx": "PRESCRIPTION",
    "prescription slip": "PRESCRIPTION",
    "prescription slips": "PRESCRIPTION",
    "presceription": "PRESCRIPTION",
    # Lab report
    "lab": "LAB_REPORT",
    "lab report": "LAB_REPORT",
    "lab_report": "LAB_REPORT",
    "laboratory": "LAB_REPORT",
    "laboratory report": "LAB_REPORT",
    "laboratory_report": "LAB_REPORT",
    "lab test": "LAB_REPORT",
    "lab_test": "LAB_REPORT",
    "test report": "LAB_REPORT",
    "test_report": "LAB_REPORT",
    "blood test": "LAB_REPORT",
    "blood_test": "LAB_REPORT",
    "blood report": "LAB_REPORT",
    "blood_report": "LAB_REPORT",
    "cbc": "LAB_REPORT",
    "cbc report": "LAB_REPORT",
    "cbc_report": "LAB_REPORT",
    "pathology": "LAB_REPORT",
    "pathology report": "LAB_REPORT",
    "pathology_report": "LAB_REPORT",
    "biochemistry": "LAB_REPORT",
    "biochemistry report": "LAB_REPORT",
    "biochemistry_report": "LAB_REPORT",
    "lipid profile": "LAB_REPORT",
    "lipid_profile": "LAB_REPORT",
    "metabolic panel": "LAB_REPORT",
    # Imaging report
    "imaging": "IMAGING_REPORT",
    "imaging report": "IMAGING_REPORT",
    "imaging_report": "IMAGING_REPORT",
    "diagnostic imaging": "IMAGING_REPORT",
    "diagnostic_imaging": "IMAGING_REPORT",
    "radiology": "IMAGING_REPORT",
    "radiology report": "IMAGING_REPORT",
    "x-ray": "IMAGING_REPORT",
    "xray": "IMAGING_REPORT",
    "x_ray": "IMAGING_REPORT",
    "mri": "IMAGING_REPORT",
    "mri scan": "IMAGING_REPORT",
    "ct": "IMAGING_REPORT",
    "ct scan": "IMAGING_REPORT",
    "ultrasound": "IMAGING_REPORT",
    "sonography": "IMAGING_REPORT",
    "usg": "IMAGING_REPORT",
    "usg scan": "IMAGING_REPORT",
    "echocardiogram": "IMAGING_REPORT",
    "echo": "IMAGING_REPORT",
    "ecg": "IMAGING_REPORT",
    # Discharge summary
    "discharge": "DISCHARGE_SUMMARY",
    "discharge summary": "DISCHARGE_SUMMARY",
    "discharge_summary": "DISCHARGE_SUMMARY",
    "discharge card": "DISCHARGE_SUMMARY",
    "discharge slip": "DISCHARGE_SUMMARY",
    "discharge report": "DISCHARGE_SUMMARY",
    # Consultation report
    "consultation": "CONSULTATION_REPORT",
    "consultation report": "CONSULTATION_REPORT",
    "consultation_report": "CONSULTATION_REPORT",
    "consultation note": "CONSULTATION_REPORT",
    "consultation_note": "CONSULTATION_REPORT",
    "doctor note": "CONSULTATION_REPORT",
    "doctor_note": "CONSULTATION_REPORT",
    "clinical note": "CONSULTATION_REPORT",
    "clinical_note": "CONSULTATION_REPORT",
    "opd note": "CONSULTATION_REPORT",
    "opd_note": "CONSULTATION_REPORT",
    "referral letter": "CONSULTATION_REPORT",
    # Surgery / Procedure report
    "surgery": "SURGERY_PROCEDURE_REPORT",
    "surgery report": "SURGERY_PROCEDURE_REPORT",
    "surgery procedure report": "SURGERY_PROCEDURE_REPORT",
    "surgery_procedure_report": "SURGERY_PROCEDURE_REPORT",
    "procedure": "SURGERY_PROCEDURE_REPORT",
    "procedure report": "SURGERY_PROCEDURE_REPORT",
    "operation": "SURGERY_PROCEDURE_REPORT",
    "operative note": "SURGERY_PROCEDURE_REPORT",
    "surgical note": "SURGERY_PROCEDURE_REPORT",
    # Vaccination record
    "vaccination": "VACCINATION_RECORD",
    "vaccination record": "VACCINATION_RECORD",
    "vaccination_record": "VACCINATION_RECORD",
    "vaccine": "VACCINATION_RECORD",
    "vaccine card": "VACCINATION_RECORD",
    "immunization": "VACCINATION_RECORD",
    "immunization record": "VACCINATION_RECORD",
    # Medical certificate
    "medical certificate": "MEDICAL_CERTIFICATE",
    "medical_certificate": "MEDICAL_CERTIFICATE",
    "certificate": "MEDICAL_CERTIFICATE",
    "fitness certificate": "MEDICAL_CERTIFICATE",
    # Explicit other
    "other": "OTHER_MEDICAL_DOCUMENT",
    "other medical document": "OTHER_MEDICAL_DOCUMENT",
    "other_medical_document": "OTHER_MEDICAL_DOCUMENT",
}


def normalize_document_type(raw_type: Any) -> str | None:
    """Normalize raw document type string to one of the 9 canonical PostgreSQL enum values.

    Returns:
        The canonical uppercase string if valid or mapped.
        None if missing or invalid/unrecognized (to preserve existing DB value).
        'OTHER_MEDICAL_DOCUMENT' only when explicitly requested.
    """
    if not raw_type or not isinstance(raw_type, str):
        return None

    cleaned = raw_type.strip()
    if not cleaned:
        return None

    upper = cleaned.upper().replace("-", "_").replace(" ", "_")
    if upper in CANONICAL_DOCUMENT_TYPES:
        return upper

    lower = cleaned.lower()
    if lower in DOCUMENT_TYPE_ALIAS_MAP:
        return DOCUMENT_TYPE_ALIAS_MAP[lower]

    spaced = re.sub(r"[\s\-_/.]+", " ", lower).strip()
    if spaced in DOCUMENT_TYPE_ALIAS_MAP:
        return DOCUMENT_TYPE_ALIAS_MAP[spaced]

    underscored = re.sub(r"[\s\-_/.]+", "_", lower).strip()
    if underscored in DOCUMENT_TYPE_ALIAS_MAP:
        return DOCUMENT_TYPE_ALIAS_MAP[underscored]

    # Regex patterns for clinical documents
    if re.search(r"\b(x[\-_]?ray|mri|ct(\s*scan)?|ultrasound|sonograph(y|ic)|usg|radiolog(y|ic)|imaging|echo(cardiogram)?)\b", lower):
        return "IMAGING_REPORT"
    if re.search(r"\b(blood|cbc|lab|labs|laboratory|pathology|biochemistry|hematology|urine\s*test|lipid|thyroid|test\s*report)\b", lower):
        return "LAB_REPORT"
    if re.search(r"\b(prescription|prescriptions|presceription|rx)\b", lower):
        return "PRESCRIPTION"
    if re.search(r"\b(discharge(\s*summary|\s*card|\s*slip|\s*report)?)\b", lower):
        return "DISCHARGE_SUMMARY"
    if re.search(r"\b(consultation|doctor\s*note|clinical\s*note|opd\s*note)\b", lower):
        return "CONSULTATION_REPORT"
    if re.search(r"\b(surgery|procedure|operation|operative)\b", lower):
        return "SURGERY_PROCEDURE_REPORT"
    if re.search(r"\b(vaccin(e|ation)?|immuniz(e|ation)?)\b", lower):
        return "VACCINATION_RECORD"
    if re.search(r"\b(certificate|fitness\s*cert)\b", lower):
        return "MEDICAL_CERTIFICATE"

    if lower in ("other", "other medical document", "other_medical_document", "other medical"):
        return "OTHER_MEDICAL_DOCUMENT"

    return None


class ReconcileResult(NamedTuple):
    requeued: list[UUID]
    failed_unuploaded: list[UUID]
    failed_exceeded: list[UUID]

    @property
    def failed(self) -> list[UUID]:
        return self.failed_unuploaded + self.failed_exceeded


class JobRepository:
    def __init__(self, db: Database) -> None:
        self.db = db

    async def get_job_by_id(self, job_id: UUID) -> dict[str, Any] | None:
        query = text(
            """
            SELECT id, file_key, user_id, status, stage, stage_status,
                   attempt_count, percentage, current_step, completed_steps,
                   pending_steps, completed_stages, retryable, requires_reupload,
                   message, metadata, checkpoint_data, raw_ocr_data,
                   extracted_structured_data, graphs, error,
                   last_heartbeat_at, started_at, completed_at, expires_at,
                   created_at, updated_at
            FROM document_processing_jobs
            WHERE id = :job_id
            """
        )
        async for session in self.db.session():
            result = await session.execute(query, {"job_id": job_id})
            row = result.mappings().first()
            return dict(row) if row else None

    async def get_job_by_file_key(self, file_key: str) -> dict[str, Any] | None:
        query = text(
            """
            SELECT id, file_key, user_id, status, stage, stage_status,
                   attempt_count, percentage, current_step, completed_steps,
                   pending_steps, completed_stages, retryable, requires_reupload,
                   message, metadata, checkpoint_data, raw_ocr_data,
                   extracted_structured_data, graphs, error,
                   last_heartbeat_at, started_at, completed_at, expires_at,
                   created_at, updated_at
            FROM document_processing_jobs
            WHERE file_key = :file_key
            """
        )
        async for session in self.db.session():
            result = await session.execute(query, {"file_key": file_key})
            row = result.mappings().first()
            return dict(row) if row else None

    async def claim_next_job(self) -> dict[str, Any] | None:
        query = text(
            """
            UPDATE document_processing_jobs
            SET status = 'RUNNING',
                stage_status = 'IN_PROGRESS',
                started_at = NOW(),
                last_heartbeat_at = NOW(),
                attempt_count = attempt_count + 1,
                updated_at = NOW()
            WHERE id = (
                SELECT id FROM document_processing_jobs
                WHERE status = 'QUEUED'
                  AND (metadata->>'processor' IS NULL OR metadata->>'processor' = 'python')
                ORDER BY created_at ASC
                FOR UPDATE SKIP LOCKED
                LIMIT 1
            )
            RETURNING id, file_key, user_id, status, stage, stage_status,
                      attempt_count, percentage, current_step, completed_stages,
                      checkpoint_data, metadata, raw_ocr_data, extracted_structured_data
            """
        )
        async for session in self.db.session():
            result = await session.execute(query)
            await session.commit()
            row = result.mappings().first()
            return dict(row) if row else None

    async def claim_specific_job(self, job_id: UUID) -> dict[str, Any] | None:
        query = text(
            """
            UPDATE document_processing_jobs
            SET status = 'RUNNING',
                stage_status = 'IN_PROGRESS',
                started_at = NOW(),
                last_heartbeat_at = NOW(),
                attempt_count = attempt_count + 1,
                updated_at = NOW()
            WHERE id = :job_id
              AND status = 'QUEUED'
            RETURNING id, file_key, user_id, status, stage, stage_status,
                      attempt_count, percentage, current_step, completed_stages,
                      checkpoint_data, metadata, raw_ocr_data, extracted_structured_data
            """
        )
        async for session in self.db.session():
            result = await session.execute(query, {"job_id": job_id})
            await session.commit()
            row = result.mappings().first()
            return dict(row) if row else None

    async def update_job_heartbeat(self, job_id: UUID) -> bool:
        query = text(
            """
            UPDATE document_processing_jobs
            SET last_heartbeat_at = NOW(),
                updated_at = NOW()
            WHERE id = :job_id
              AND status = 'RUNNING'
            """
        )
        async for session in self.db.session():
            result = await session.execute(query, {"job_id": job_id})
            await session.commit()
            return bool(result.rowcount and result.rowcount > 0)

    async def update_job_checkpoint(
        self,
        job_id: UUID,
        stage: str,
        stage_status: str,
        percentage: int,
        message: str,
        completed_stages: list[str],
        checkpoint_data: dict[str, Any],
        raw_ocr_data: dict[str, Any] | None = None,
        extracted_structured_data: dict[str, Any] | None = None,
        attempt_count: int | None = None,
    ) -> bool:
        query = text(
            """
            UPDATE document_processing_jobs
            SET stage = :stage,
                stage_status = :stage_status,
                percentage = :percentage,
                message = :message,
                completed_stages = :completed_stages,
                checkpoint_data = :checkpoint_data,
                raw_ocr_data = COALESCE(:raw_ocr_data, raw_ocr_data),
                extracted_structured_data = COALESCE(:extracted_structured_data, extracted_structured_data),
                last_heartbeat_at = NOW(),
                updated_at = NOW()
            WHERE id = :job_id
              AND status = 'RUNNING'
              AND (CAST(:attempt_count AS INTEGER) IS NULL OR attempt_count = CAST(:attempt_count AS INTEGER))
            """
        )
        params = {
            "job_id": job_id,
            "stage": stage,
            "stage_status": stage_status,
            "percentage": percentage,
            "message": message,
            "completed_stages": completed_stages,
            "checkpoint_data": json.dumps(checkpoint_data),
            "raw_ocr_data": json.dumps(raw_ocr_data) if raw_ocr_data is not None else None,
            "extracted_structured_data": json.dumps(extracted_structured_data) if extracted_structured_data is not None else None,
            "attempt_count": attempt_count,
        }
        async for session in self.db.session():
            result = await session.execute(query, params)
            await session.commit()
            return bool(result.rowcount and result.rowcount > 0)
        return False

    async def complete_job(
        self,
        job_id: UUID,
        message: str,
        completed_stages: list[str],
        checkpoint_data: dict[str, Any],
        raw_ocr_data: dict[str, Any] | None = None,
        extracted_structured_data: dict[str, Any] | None = None,
        status: str = "COMPLETED",
        attempt_count: int | None = None,
    ) -> bool:
        query = text(
            """
            UPDATE document_processing_jobs
            SET status = :status,
                stage = 'EMBEDDING',
                stage_status = :status,
                percentage = 100,
                message = :message,
                completed_stages = :completed_stages,
                checkpoint_data = :checkpoint_data,
                raw_ocr_data = COALESCE(:raw_ocr_data, raw_ocr_data),
                extracted_structured_data = COALESCE(:extracted_structured_data, extracted_structured_data),
                completed_at = NOW(),
                last_heartbeat_at = NOW(),
                updated_at = NOW()
            WHERE id = :job_id
              AND status = 'RUNNING'
              AND (CAST(:attempt_count AS INTEGER) IS NULL OR attempt_count = CAST(:attempt_count AS INTEGER))
            """
        )
        params = {
            "job_id": job_id,
            "status": status,
            "message": message,
            "completed_stages": completed_stages,
            "checkpoint_data": json.dumps(checkpoint_data),
            "raw_ocr_data": json.dumps(raw_ocr_data) if raw_ocr_data is not None else None,
            "extracted_structured_data": json.dumps(extracted_structured_data) if extracted_structured_data is not None else None,
            "attempt_count": attempt_count,
        }
        async for session in self.db.session():
            result = await session.execute(query, params)
            await session.commit()
            return bool(result.rowcount and result.rowcount > 0)
        return False

    async def sync_to_documents_table(
        self,
        document_id: UUID,
        extracted_structured_data: dict[str, Any] | None = None,
        raw_ocr_data: dict[str, Any] | None = None,
    ) -> None:
        raw_text = None
        if raw_ocr_data and isinstance(raw_ocr_data, dict):
            raw_text = raw_ocr_data.get("fullText")

        summary_english = None
        report_date: date | None = None
        doctor_name: str | None = None
        hospital_name: str | None = None
        doc_ocr_status = "completed"
        doc_type: str | None = None

        if extracted_structured_data and isinstance(extracted_structured_data, dict):
            summary_english = extracted_structured_data.get("summaryEnglish")
            if extracted_structured_data.get("status") == "partial":
                doc_ocr_status = "partial"

            raw_doc_type = (
                (extracted_structured_data.get("documentInfo") or {}).get("documentType")
                or (extracted_structured_data.get("documentInfo") or {}).get("rawClassification")
                or extracted_structured_data.get("documentType")
                or extracted_structured_data.get("reportType")
            )
            doc_type = normalize_document_type(raw_doc_type)

            # Ensure retry and partial OCR processing cannot overwrite a valid classified type with an unknown fallback
            if doc_ocr_status == "partial" and doc_type == "OTHER_MEDICAL_DOCUMENT":
                doc_type = None

            raw_date = (
                extracted_structured_data.get("reportDate")
                or extracted_structured_data.get("report_date")
                or (extracted_structured_data.get("documentInfo") or {}).get("documentDate")
                or (extracted_structured_data.get("documentInfo") or {}).get("reportDate")
            )
            if raw_date:
                if isinstance(raw_date, date) and not isinstance(raw_date, datetime):
                    report_date = raw_date
                elif isinstance(raw_date, datetime):
                    report_date = raw_date.date()
                elif isinstance(raw_date, str):
                    clean_date_str = raw_date.strip()
                    for fmt in ("%d-%b-%Y", "%d-%B-%Y", "%Y-%m-%d", "%d/%m/%Y"):
                        try:
                            report_date = datetime.strptime(clean_date_str, fmt).date()
                            break
                        except ValueError:
                            pass

            doctor_name = (
                extracted_structured_data.get("doctorName")
                or extracted_structured_data.get("doctor_name")
                or (extracted_structured_data.get("providerInfo") or {}).get("referringDoctor")
                or ((extracted_structured_data.get("providerInfo") or {}).get("primary") or {}).get("name")
            )

            hospital_name = (
                extracted_structured_data.get("hospitalName")
                or extracted_structured_data.get("hospital_name")
                or (extracted_structured_data.get("facilityInfo") or {}).get("name")
            )

        query = text(
            """
            UPDATE documents
            SET ocr_status = :doc_ocr_status,
                document_type = COALESCE(CAST(:doc_type AS document_type), document_type),
                structured_extracted_data = COALESCE(:extracted_structured_data, structured_extracted_data),
                ocr_extracted_text = COALESCE(:raw_text, ocr_extracted_text),
                summary_english = COALESCE(:summary_english, summary_english),
                report_date = COALESCE(:report_date, report_date),
                doctor_name = COALESCE(:doctor_name, doctor_name),
                hospital_name = COALESCE(:hospital_name, hospital_name),
                updated_at = NOW()
            WHERE id = :document_id
            """
        )
        params = {
            "document_id": document_id,
            "doc_ocr_status": doc_ocr_status,
            "doc_type": doc_type,
            "extracted_structured_data": json.dumps(extracted_structured_data) if extracted_structured_data is not None else None,
            "raw_text": raw_text,
            "summary_english": summary_english,
            "report_date": report_date,
            "doctor_name": doctor_name,
            "hospital_name": hospital_name,
        }
        async for session in self.db.session():
            await session.execute(query, params)
            await session.commit()


    async def fail_job(
        self,
        job_id: UUID,
        error: str,
        failed_stage: str | None = None,
        message: str | None = None,
        completed_stages: list[str] | None = None,
        checkpoint_data: dict[str, Any] | None = None,
        retryable: bool = True,
        requires_reupload: bool = False,
        attempt_count: int | None = None,
        error_code: str | None = None,
        stage_details: dict[str, Any] | None = None,
        **kwargs: Any,
    ) -> bool:
        if error_code or stage_details:
            checkpoint_data = dict(checkpoint_data or {})
            if error_code and "error_code" not in checkpoint_data:
                checkpoint_data["error_code"] = error_code
            if stage_details and "stage_details" not in checkpoint_data:
                checkpoint_data["stage_details"] = stage_details

        query = text(
            """
            UPDATE document_processing_jobs
            SET status = 'FAILED',
                stage = COALESCE(:failed_stage, stage),
                stage_status = 'FAILED',
                error = :error,
                message = COALESCE(:message, :error),
                retryable = :retryable,
                requires_reupload = :requires_reupload,
                completed_stages = COALESCE(:completed_stages, completed_stages),
                checkpoint_data = COALESCE(CAST(:checkpoint_data AS JSONB), checkpoint_data),
                updated_at = NOW()
            WHERE id = :job_id
              AND status = 'RUNNING'
              AND (CAST(:attempt_count AS INTEGER) IS NULL OR attempt_count = CAST(:attempt_count AS INTEGER))
            """
        )
        params = {
            "job_id": job_id,
            "failed_stage": failed_stage,
            "error": error,
            "message": message,
            "completed_stages": completed_stages,
            "checkpoint_data": json.dumps(checkpoint_data) if checkpoint_data is not None else None,
            "retryable": retryable,
            "requires_reupload": requires_reupload,
            "attempt_count": attempt_count,
        }
        try:
            async for session in self.db.session():
                result = await session.execute(query, params)
                await session.commit()
                return bool(result.rowcount and result.rowcount > 0)
        except Exception as e:
            logger.error(
                "Primary fail_job query failed for job %s: %s. Executing emergency fallback update.",
                job_id,
                e,
                exc_info=True,
            )
            try:
                from app.core.errors import sanitize_pipeline_error

                emergency_query = text(
                    """
                    UPDATE document_processing_jobs
                    SET status = 'FAILED',
                        stage_status = 'FAILED',
                        error = :error,
                        updated_at = NOW()
                    WHERE id = :job_id
                    """
                )
                clean_err = sanitize_pipeline_error(error)
                async for session in self.db.session():
                    result = await session.execute(
                        emergency_query,
                        {"job_id": job_id, "error": clean_err},
                    )
                    await session.commit()
                    return bool(result.rowcount and result.rowcount > 0)
            except Exception as fb_err:
                logger.critical(
                    "Emergency fallback fail_job also failed for job %s: %s",
                    job_id,
                    fb_err,
                    exc_info=True,
                )
        return False

    async def reject_job(self, job_id: UUID, reason: str) -> None:
        query = text(
            """
            UPDATE document_processing_jobs
            SET status = 'REJECTED',
                stage_status = 'REJECTED',
                retryable = FALSE,
                error = :reason,
                updated_at = NOW()
            WHERE id = :job_id
              AND status = 'RUNNING'
            """
        )
        async for session in self.db.session():
            await session.execute(query, {"job_id": job_id, "reason": reason})
            await session.commit()

    async def reconcile_stale_jobs(
        self, stale_seconds: float = 180.0, max_attempts: int = 3
    ) -> ReconcileResult:
        failed_exceeded_query = text(
            """
            UPDATE document_processing_jobs
            SET status = 'FAILED',
                stage_status = 'FAILED',
                retryable = FALSE,
                requires_reupload = FALSE,
                error = 'Worker heartbeat timed out. Maximum retry attempts exceeded.',
                updated_at = NOW()
            WHERE status = 'RUNNING'
              AND COALESCE(last_heartbeat_at, started_at, created_at) < NOW() - make_interval(secs => :stale_seconds)
              AND attempt_count >= :max_attempts
            RETURNING id
            """
        )
        requeued_query = text(
            """
            UPDATE document_processing_jobs
            SET status = 'QUEUED',
                stage_status = 'QUEUED',
                error = 'Worker heartbeat timed out. Requeued for retry from checkpoint.',
                message = 'Resuming execution from checkpoint after worker heartbeat timeout',
                updated_at = NOW()
            WHERE status = 'RUNNING'
              AND COALESCE(last_heartbeat_at, started_at, created_at) < NOW() - make_interval(secs => :stale_seconds)
              AND attempt_count < :max_attempts
              AND (
                  'UPLOADING' = ANY(completed_stages)
                  OR checkpoint_data->>'uploaded' = 'true'
                  OR checkpoint_data->'UPLOADING'->>'uploaded' = 'true'
                  OR (checkpoint_data->>'s3Key' IS NOT NULL AND checkpoint_data->>'s3Key' != '')
              )
            RETURNING id
            """
        )
        failed_unuploaded_query = text(
            """
            UPDATE document_processing_jobs
            SET status = 'FAILED',
                stage_status = 'FAILED',
                retryable = TRUE,
                requires_reupload = TRUE,
                error = 'Worker crashed before document upload completed; please retry with file.',
                updated_at = NOW()
            WHERE status = 'RUNNING'
              AND COALESCE(last_heartbeat_at, started_at, created_at) < NOW() - make_interval(secs => :stale_seconds)
              AND attempt_count < :max_attempts
              AND NOT (
                  'UPLOADING' = ANY(completed_stages)
                  OR checkpoint_data->>'uploaded' = 'true'
                  OR checkpoint_data->'UPLOADING'->>'uploaded' = 'true'
                  OR (checkpoint_data->>'s3Key' IS NOT NULL AND checkpoint_data->>'s3Key' != '')
              )
            RETURNING id
            """
        )
        async for session in self.db.session():
            res_failed_exceeded = await session.execute(
                failed_exceeded_query,
                {"stale_seconds": stale_seconds, "max_attempts": max_attempts},
            )
            res_requeued = await session.execute(
                requeued_query,
                {"stale_seconds": stale_seconds, "max_attempts": max_attempts},
            )
            res_failed_unuploaded = await session.execute(
                failed_unuploaded_query,
                {"stale_seconds": stale_seconds, "max_attempts": max_attempts},
            )
            await session.commit()
            failed_exceeded_ids = [row[0] for row in res_failed_exceeded.fetchall()]
            requeued_ids = [row[0] for row in res_requeued.fetchall()]
            failed_unuploaded_ids = [row[0] for row in res_failed_unuploaded.fetchall()]
            return ReconcileResult(
                requeued=requeued_ids,
                failed_unuploaded=failed_unuploaded_ids,
                failed_exceeded=failed_exceeded_ids,
            )
