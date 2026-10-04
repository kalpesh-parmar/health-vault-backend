from __future__ import annotations

import logging
import time
import uuid
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import date, datetime, timezone
from typing import Any
from uuid import UUID

from sqlalchemy import delete, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.infrastructure.db.models import PatientLabResult
from app.infrastructure.db.session import Database
from app.services.pipeline.lab_evaluator import LabEvaluator, normalize_test_key, parse_numeric_value

logger = logging.getLogger(__name__)


def _parse_datetime(val: Any) -> datetime | None:
    if val is None:
        return None
    if isinstance(val, datetime):
        return val if val.tzinfo is not None else val.replace(tzinfo=timezone.utc)
    if isinstance(val, date):
        return datetime(val.year, val.month, val.day, tzinfo=timezone.utc)
    if isinstance(val, str):
        cleaned = val.strip()
        if not cleaned:
            return None
        try:
            dt = datetime.fromisoformat(cleaned.replace("Z", "+00:00"))
            return dt if dt.tzinfo is not None else dt.replace(tzinfo=timezone.utc)
        except ValueError:
            pass
        for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%m/%d/%Y", "%d-%m-%Y", "%Y/%m/%d"):
            try:
                return datetime.strptime(cleaned, fmt).replace(tzinfo=timezone.utc)
            except ValueError:
                continue
    return None


class LabResultRepository:
    """Single-writer repository for persisting and querying structured patient lab results."""

    def __init__(
        self,
        db: Database | None = None,
        session: AsyncSession | None = None,
    ) -> None:
        self.db = db
        self.session = session

    @asynccontextmanager
    async def _get_session(self) -> AsyncIterator[AsyncSession]:
        if self.session is not None:
            yield self.session
        elif self.db is not None:
            async for s in self.db.session():
                yield s
        else:
            raise RuntimeError("Neither db nor session configured on LabResultRepository")

    async def persist_lab_results(
        self,
        *,
        user_id: UUID | str,
        document_id: UUID | str | None = None,
        report_id: str | None = None,
        lab_items: list[dict[str, Any]],
        test_date: datetime | str | None = None,
    ) -> list[dict[str, Any]]:
        """Idempotently persist extracted lab results for a patient document.
        
        Clears existing records for (user_id, document_id) within the transaction
        before inserting normalized records.
        """
        uid = UUID(str(user_id)) if not isinstance(user_id, UUID) else user_id
        doc_id = (UUID(str(document_id)) if not isinstance(document_id, UUID) else document_id) if document_id else None
        parsed_doc_date = _parse_datetime(test_date)

        if not lab_items and doc_id is None:
            return []

        async with self._get_session() as session:
            # 1. Idempotency cleanup: delete existing rows for this document
            if doc_id is not None:
                await session.execute(
                    delete(PatientLabResult).where(
                        PatientLabResult.user_id == uid,
                        PatientLabResult.document_id == doc_id,
                    )
                )

            if not lab_items:
                await session.commit()
                return []

            # 2. Normalize and construct rows
            persisted_entities: list[PatientLabResult] = []
            for item in lab_items:
                test_name = str(item.get("testName") or item.get("name") or item.get("parameter") or "Unknown Test").strip()
                
                # Use pre-evaluated canonicalKey or resolve via normalize_test_key
                canonical_key = item.get("canonicalKey") or normalize_test_key(test_name)
                
                # Check if item has evaluated fields; if not, evaluate
                if "flag" not in item or "isAbnormal" not in item:
                    eval_res = LabEvaluator.evaluate_result(test_name, item.get("value"), unit=item.get("unit"))
                    merged_item = {**item, **eval_res}
                else:
                    merged_item = item

                # Value numeric
                num_val = merged_item.get("value")
                val_numeric: float | None = None
                if isinstance(num_val, (int, float)) and not isinstance(num_val, bool):
                    val_numeric = float(num_val)
                elif num_val is not None:
                    val_numeric = parse_numeric_value(num_val)

                val_text = str(merged_item.get("rawValue") or merged_item.get("value") or "").strip()
                unit = str(merged_item.get("unit") or "").strip() or None
                ref_range = str(merged_item.get("referenceRange") or "").strip() or None
                flag = str(merged_item.get("flag") or "NORMAL").upper()
                is_abnormal = bool(merged_item.get("isAbnormal", False))
                is_critical = bool(merged_item.get("isCritical", False))
                
                # Item date with fallback to document test_date
                item_date = _parse_datetime(merged_item.get("testDate") or merged_item.get("date")) or parsed_doc_date
                page_no = int(merged_item.get("pageNo") or merged_item.get("page") or 1)
                confidence = float(merged_item["confidence"]) if merged_item.get("confidence") is not None else None

                # Additional metadata (strip core columns to prevent duplication)
                reserved_keys = {
                    "testName", "canonicalKey", "value", "rawValue", "unit",
                    "referenceRange", "flag", "isAbnormal", "isCritical",
                    "testDate", "date", "pageNo", "page", "confidence",
                }
                extra_meta = {k: v for k, v in merged_item.items() if k not in reserved_keys and v is not None}

                entity = PatientLabResult(
                    user_id=uid,
                    document_id=doc_id,
                    report_id=report_id,
                    canonical_key=canonical_key,
                    test_name=test_name,
                    value_numeric=val_numeric,
                    value_text=val_text or None,
                    unit=unit,
                    reference_range=ref_range,
                    flag=flag,
                    is_abnormal=is_abnormal,
                    is_critical=is_critical,
                    test_date=item_date,
                    page_no=page_no,
                    confidence=confidence,
                    metadata_=extra_meta,
                )
                session.add(entity)
                persisted_entities.append(entity)

            await session.commit()

            # Refresh and format dict summaries
            return [
                {
                    "id": str(e.id),
                    "userId": str(e.user_id),
                    "documentId": str(e.document_id) if e.document_id else None,
                    "reportId": e.report_id,
                    "canonicalKey": e.canonical_key,
                    "testName": e.test_name,
                    "valueNumeric": e.value_numeric,
                    "valueText": e.value_text,
                    "unit": e.unit,
                    "referenceRange": e.reference_range,
                    "flag": e.flag,
                    "isAbnormal": e.is_abnormal,
                    "isCritical": e.is_critical,
                    "testDate": e.test_date.isoformat() if e.test_date else None,
                    "pageNo": e.page_no,
                    "confidence": e.confidence,
                    "metadata": e.metadata_,
                }
                for e in persisted_entities
            ]

    async def query_longitudinal(
        self,
        *,
        user_id: UUID | str,
        canonical_key: str,
        limit: int = 20,
        session: AsyncSession | None = None,
    ) -> dict[str, Any]:
        """Query historical values for a canonical lab parameter sorted chronologically descending.
        
        Leverages composite index (user_id, canonical_key, test_date DESC) for < 5 ms retrieval.
        """
        uid = UUID(str(user_id)) if not isinstance(user_id, UUID) else user_id
        canonical = canonical_key.strip().lower()

        started = time.perf_counter()
        
        stmt = text(
            """
            SELECT id, user_id, document_id, report_id, canonical_key, test_name,
                   value_numeric, value_text, unit, reference_range, flag,
                   is_abnormal, is_critical, test_date, page_no, confidence,
                   metadata, created_at
            FROM patient_lab_results
            WHERE user_id = :user_id AND canonical_key = :canonical_key
            ORDER BY test_date DESC NULLS LAST
            LIMIT :limit
            """
        )
        params = {"user_id": uid, "canonical_key": canonical, "limit": limit}

        if session is not None:
            res = await session.execute(stmt, params)
            rows = res.mappings().all()
        else:
            async with self._get_session() as s:
                res = await s.execute(stmt, params)
                rows = res.mappings().all()

        elapsed_ms = (time.perf_counter() - started) * 1000

        results = [
            {
                "id": str(r["id"]),
                "userId": str(r["user_id"]),
                "documentId": str(r["document_id"]) if r["document_id"] else None,
                "reportId": r["report_id"],
                "testName": r["test_name"],
                "canonicalKey": r["canonical_key"],
                "valueNumeric": r["value_numeric"],
                "valueText": r["value_text"],
                "unit": r["unit"],
                "referenceRange": r["reference_range"],
                "flag": r["flag"],
                "isAbnormal": bool(r["is_abnormal"]),
                "isCritical": bool(r["is_critical"]),
                "testDate": r["test_date"].isoformat() if r["test_date"] else None,
                "pageNo": r["page_no"],
                "confidence": r["confidence"],
                "metadata": r["metadata"] or {},
                "createdAt": r["created_at"].isoformat() if r["created_at"] else None,
            }
            for r in rows
        ]

        logger.debug(
            "query_longitudinal: user_id=%s, canonical_key=%s, count=%d, elapsed_ms=%.3f",
            uid,
            canonical,
            len(results),
            elapsed_ms,
        )

        return {
            "userId": str(uid),
            "canonicalKey": canonical,
            "count": len(results),
            "elapsedMs": round(elapsed_ms, 3),
            "results": results,
        }

    async def get_by_document(
        self,
        *,
        user_id: UUID | str,
        document_id: UUID | str,
        session: AsyncSession | None = None,
    ) -> list[dict[str, Any]]:
        """Retrieve all lab results associated with a specific document."""
        uid = UUID(str(user_id)) if not isinstance(user_id, UUID) else user_id
        doc_id = UUID(str(document_id)) if not isinstance(document_id, UUID) else document_id

        stmt = text(
            """
            SELECT id, canonical_key, test_name, value_numeric, value_text,
                   unit, reference_range, flag, is_abnormal, is_critical,
                   test_date, page_no, confidence
            FROM patient_lab_results
            WHERE user_id = :user_id AND document_id = :document_id
            ORDER BY page_no ASC, test_name ASC
            """
        )
        params = {"user_id": uid, "document_id": doc_id}

        if session is not None:
            res = await session.execute(stmt, params)
            rows = res.mappings().all()
        else:
            async with self._get_session() as s:
                res = await s.execute(stmt, params)
                rows = res.mappings().all()

        return [
            {
                "id": str(r["id"]),
                "canonicalKey": r["canonical_key"],
                "testName": r["test_name"],
                "valueNumeric": r["value_numeric"],
                "valueText": r["value_text"],
                "unit": r["unit"],
                "referenceRange": r["reference_range"],
                "flag": r["flag"],
                "isAbnormal": bool(r["is_abnormal"]),
                "isCritical": bool(r["is_critical"]),
                "testDate": r["test_date"].isoformat() if r["test_date"] else None,
                "pageNo": r["page_no"],
                "confidence": r["confidence"],
            }
            for r in rows
        ]
