const { and, eq, inArray, gte, lte, desc, asc, sql } = require("drizzle-orm");
const { db } = require("../configs/db");
const { patientLabResult } = require("../models/patientLabResult");

class PatientLabResultRepository {
  /**
   * Find results for a specific patient and canonical test key.
   */
  async findByCanonicalKey(
    userId,
    canonicalKey,
    { startDate, endDate, limit = 50, documentIds } = {},
  ) {
    const conditions = [
      eq(patientLabResult.userId, userId),
      eq(patientLabResult.canonicalKey, canonicalKey),
    ];

    if (documentIds && Array.isArray(documentIds) && documentIds.length > 0) {
      conditions.push(inArray(patientLabResult.documentId, documentIds));
    }

    if (startDate) {
      conditions.push(gte(patientLabResult.testDate, new Date(startDate)));
    }
    if (endDate) {
      conditions.push(lte(patientLabResult.testDate, new Date(endDate)));
    }

    const rows = await db
      .select()
      .from(patientLabResult)
      .where(and(...conditions))
      .orderBy(desc(patientLabResult.testDate))
      .limit(limit);

    return rows.reverse();
  }

  /**
   * Find results matching multiple canonical keys.
   */
  async findByCanonicalKeys(userId, canonicalKeys, { limit = 100 } = {}) {
    if (!canonicalKeys || canonicalKeys.length === 0) return [];
    return db
      .select()
      .from(patientLabResult)
      .where(
        and(
          eq(patientLabResult.userId, userId),
          inArray(patientLabResult.canonicalKey, canonicalKeys),
        ),
      )
      .orderBy(desc(patientLabResult.testDate))
      .limit(limit);
  }

  /**
   * Find all lab results extracted for a specific document.
   */
  async findByDocumentId(documentId) {
    return db
      .select()
      .from(patientLabResult)
      .where(eq(patientLabResult.documentId, documentId))
      .orderBy(asc(patientLabResult.pageNo), asc(patientLabResult.testName));
  }

  /**
   * Find lab results for a specific patient ID with verified attributes.
   * Optionally filtered by specific document IDs to prevent cross-document fact contamination.
   */
  async findLabResultsByPatientId(userId, { limit = 50, documentIds } = {}) {
    const conditions = [eq(patientLabResult.userId, userId)];
    if (documentIds && Array.isArray(documentIds) && documentIds.length > 0) {
      conditions.push(inArray(patientLabResult.documentId, documentIds));
    }

    return db
      .select({
        id: patientLabResult.id,
        userId: patientLabResult.userId,
        documentId: patientLabResult.documentId,
        testName: patientLabResult.testName,
        canonicalName: patientLabResult.canonicalKey,
        numericValue: patientLabResult.valueNumeric,
        valueText: patientLabResult.valueText,
        unit: patientLabResult.unit,
        referenceRange: patientLabResult.referenceRange,
        status: patientLabResult.flag,
        isAbnormal: patientLabResult.isAbnormal,
        observationDate: patientLabResult.testDate,
        pageNo: patientLabResult.pageNo,
      })
      .from(patientLabResult)
      .where(and(...conditions))
      .orderBy(desc(patientLabResult.testDate))
      .limit(limit);
  }

  /**
   * Find latest lab results across all tests for a patient.
   */
  async findLatestByUserId(userId, { limit = 30 } = {}) {
    return db
      .select()
      .from(patientLabResult)
      .where(eq(patientLabResult.userId, userId))
      .orderBy(desc(patientLabResult.testDate))
      .limit(limit);
  }

  /**
   * Find abnormal or critical observations for a patient.
   */
  async findAbnormalObservations(userId, { limit = 50 } = {}) {
    return db
      .select()
      .from(patientLabResult)
      .where(and(eq(patientLabResult.userId, userId), eq(patientLabResult.isAbnormal, true)))
      .orderBy(desc(patientLabResult.testDate))
      .limit(limit);
  }

  /**
   * Batch insert lab results (used by Python pipeline or test seeders).
   */
  async insertBatch(rows) {
    if (!rows || rows.length === 0) return [];
    return db.insert(patientLabResult).values(rows).returning();
  }

  /**
   * Temporal aggregation by month or year using PostgreSQL DATE_TRUNC.
   */
  async aggregateByPeriod(
    userId,
    canonicalKey,
    period = "month",
    { startDate, endDate, documentIds } = {},
  ) {
    const validPeriods = ["month", "year", "day"];
    const truncPeriod = validPeriods.includes(period) ? period : "month";

    const conditions = [
      eq(patientLabResult.userId, userId),
      eq(patientLabResult.canonicalKey, canonicalKey),
      sql`value_numeric IS NOT NULL`,
    ];

    if (documentIds && Array.isArray(documentIds) && documentIds.length > 0) {
      conditions.push(inArray(patientLabResult.documentId, documentIds));
    }

    if (startDate) {
      conditions.push(gte(patientLabResult.testDate, new Date(startDate)));
    }
    if (endDate) {
      conditions.push(lte(patientLabResult.testDate, new Date(endDate)));
    }

    const periodExpr = sql.raw(`DATE_TRUNC('${truncPeriod}', test_date)`);

    return db
      .select({
        period: periodExpr,
        avgValue: sql`AVG(value_numeric)::numeric(10,2)`,
        minValue: sql`MIN(value_numeric)::numeric(10,2)`,
        maxValue: sql`MAX(value_numeric)::numeric(10,2)`,
        count: sql`COUNT(*)::int`,
        unit: sql`MAX(unit)`,
        referenceRange: sql`MAX(reference_range)`,
        documentId: sql`MAX(document_id::text)`,
        pageNo: sql`MAX(page_no)::int`,
      })
      .from(patientLabResult)
      .where(and(...conditions))
      .groupBy(periodExpr)
      .orderBy(periodExpr);
  }
}

const patientLabResultRepository = new PatientLabResultRepository();

module.exports = {
  patientLabResultRepository,
  PatientLabResultRepository,
};
