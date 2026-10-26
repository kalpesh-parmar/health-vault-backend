const { eq, and, sql, gte, lte, asc, desc, or, lt } = require("drizzle-orm");
const { db } = require("../configs/db");
const { medicationReminderOccurrence } = require("../models/medicationReminderOccurrence");
const { medicationReminder } = require("../models/medicationReminder");
const { medication } = require("../models/medication");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const { normalizeToDateOnly } = require("../utils/dateUtils");

function isValidTimezone(tz) {
  if (typeof tz !== "string" || !tz.trim()) return false;
  if (!/^[A-Za-z0-9_/+-]+$/.test(tz)) return false;
  try {
    Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

class MedicationReminderOccurrenceRepository {
  async bulkCreate(payload) {
    return db.insert(medicationReminderOccurrence).values(payload).returning();
  }
  async findById(id, tx = db, forUpdate = false) {
    const client = tx || db;
    let query = client
      .select()
      .from(medicationReminderOccurrence)
      .where(
        and(
          eq(medicationReminderOccurrence.id, id),
          eq(medicationReminderOccurrence.softDelete, false),
        ),
      );
    if (forUpdate) {
      if (typeof query.for !== "function") {
        throw new Error("Row locking is not supported by this query builder");
      }
      query = query.for("update");
    }
    const result = await query.limit(1);
    return result[0] || null;
  }
  async findPendingReminders(pendingStatuses, options = {}) {
    const conditions = [
      or(...pendingStatuses.map((status) => eq(medicationReminderOccurrence.status, status))),
      eq(medicationReminderOccurrence.softDelete, false),
    ];

    if (options.startTime) {
      conditions.push(gte(medicationReminderOccurrence.actualMedicationTime, options.startTime));
    }
    if (options.endTime) {
      conditions.push(lte(medicationReminderOccurrence.actualMedicationTime, options.endTime));
    }

    return db
      .select({
        occurrence: medicationReminderOccurrence,
        medication: medication,
      })
      .from(medicationReminderOccurrence)
      .innerJoin(medication, eq(medication.id, medicationReminderOccurrence.medicationId))
      .where(and(...conditions));
  }
  async findAllOccurrences(userId) {
    return db
      .select({
        id: medicationReminderOccurrence.id,
        reminderId: medicationReminderOccurrence.reminderId,
        medicationId: medicationReminderOccurrence.medicationId,
        status: medicationReminderOccurrence.status,
        actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
        completedAt: medicationReminderOccurrence.completedAt,
        delayMinutes: medicationReminderOccurrence.delayMinutes,
        completionClassification: medicationReminderOccurrence.completionClassification,
        skipReason: medicationReminderOccurrence.skipReason,
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
        isOverdue: medicationReminderOccurrence.isOverdue,
      })
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminder.id, medicationReminderOccurrence.reminderId),
      )
      .innerJoin(medication, eq(medication.id, medicationReminder.medicationId))
      .where(
        and(
          eq(medicationReminder.patientId, userId),
          eq(medicationReminderOccurrence.softDelete, false),
        ),
      )
      .orderBy(asc(medicationReminderOccurrence.actualMedicationTime));
  }

  async findTodayOccurrences(userId, timezone = "Asia/Kolkata") {
    const tz = isValidTimezone(timezone) ? timezone : "Asia/Kolkata";
    return db
      .select({
        id: medicationReminderOccurrence.id,
        reminderId: medicationReminderOccurrence.reminderId,
        medicationId: medicationReminderOccurrence.medicationId,
        status: medicationReminderOccurrence.status,
        actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
        completedAt: medicationReminderOccurrence.completedAt,
        delayMinutes: medicationReminderOccurrence.delayMinutes,
        completionClassification: medicationReminderOccurrence.completionClassification,
        skipReason: medicationReminderOccurrence.skipReason,
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
        dosePerIntake: medication.dosePerIntake,
        unit: medication.unit,
        isOverdue: medicationReminderOccurrence.isOverdue,
      })
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminder.id, medicationReminderOccurrence.reminderId),
      )
      .innerJoin(medication, eq(medication.id, medicationReminder.medicationId))
      .where(
        and(
          eq(medicationReminder.patientId, userId),
          eq(medicationReminderOccurrence.softDelete, false),
          eq(medicationReminder.softDelete, false),
          eq(medication.softDelete, false),
          sql`${medicationReminderOccurrence.status} != ${reminderOccurrenceStatus.CANCELLED}`,

          // only today's date in patient's timezone
          sql`(${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date = (NOW() AT TIME ZONE ${tz})::date`,
        ),
      )
      .orderBy(asc(medicationReminderOccurrence.actualMedicationTime));
  }

  async findOccurrencesByDate(userId, targetDate) {
    const dateStr = normalizeToDateOnly(targetDate) || targetDate;
    return db
      .select({
        id: medicationReminderOccurrence.id,
        reminderId: medicationReminderOccurrence.reminderId,
        medicationId: medicationReminderOccurrence.medicationId,
        status: medicationReminderOccurrence.status,
        actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
        completedAt: medicationReminderOccurrence.completedAt,
        delayMinutes: medicationReminderOccurrence.delayMinutes,
        completionClassification: medicationReminderOccurrence.completionClassification,
        skipReason: medicationReminderOccurrence.skipReason,
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
        isOverdue: medicationReminderOccurrence.isOverdue,
      })
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminder.id, medicationReminderOccurrence.reminderId),
      )
      .innerJoin(medication, eq(medication.id, medicationReminder.medicationId))
      .where(
        and(
          eq(medicationReminder.patientId, userId),
          eq(medicationReminderOccurrence.softDelete, false),
          sql`DATE(${medicationReminderOccurrence.actualMedicationTime}) = ${dateStr}`,
        ),
      )
      .orderBy(asc(medicationReminderOccurrence.actualMedicationTime));
  }

  async getOccurrences(userId, payload) {
    const filter = payload?.filter || {};
    const sort = payload?.sort || {};
    const pageData = payload?.page || {};
    const { status, startDate, endDate, medicationName, medicationType, date, isOverdue } = filter;
    const page = pageData.pageNumber || 1;
    const limit = pageData.pageLimit || 10;
    const offset = (page - 1) * limit;

    const conditions = [
      eq(medicationReminder.patientId, userId),
      eq(medicationReminderOccurrence.softDelete, false),
    ];
    if (status) {
      conditions.push(eq(medicationReminderOccurrence.status, status));
    }
    if (startDate) {
      conditions.push(gte(medicationReminderOccurrence.actualMedicationTime, new Date(startDate)));
    }
    if (endDate) {
      conditions.push(
        lte(medicationReminderOccurrence.actualMedicationTime, new Date(`${endDate}T23:59:59`)),
      );
    }
    if (medicationName) {
      conditions.push(sql`${medication.medicationName} ILIKE ${"%" + medicationName + "%"}`);
    }

    if (medicationType) {
      conditions.push(eq(medication.medicationType, medicationType));
    }

    if (date) {
      conditions.push(sql`DATE(${medicationReminderOccurrence.actualMedicationTime}) = ${date}`);
    }
    if (isOverdue) {
      conditions.push(eq(medicationReminderOccurrence.isOverdue, isOverdue));
    }

    const sortFieldMap = {
      actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
      completedAt: medicationReminderOccurrence.completedAt,
      createdAt: medicationReminderOccurrence.createdAt,
      status: medicationReminderOccurrence.status,
    };

    const sortColumn =
      sortFieldMap[sort?.sortBy] || medicationReminderOccurrence.actualMedicationTime;

    // GET TOTAL RECORDS
    const totalResult = await db
      .select({
        count: sql`COUNT(*)`.mapWith(Number),
      })
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminder.id, medicationReminderOccurrence.reminderId),
      )
      .innerJoin(medication, eq(medication.id, medicationReminder.medicationId))
      .where(and(...conditions));

    const totalRecords = totalResult[0]?.count || 0;
    const totalPages = Math.ceil(totalRecords / limit);

    // GET PAGINATED DATA
    const occurrences = await db
      .select({
        id: medicationReminderOccurrence.id,
        reminderId: medicationReminderOccurrence.reminderId,
        medicationId: medicationReminderOccurrence.medicationId,
        status: medicationReminderOccurrence.status,
        actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
        completedAt: medicationReminderOccurrence.completedAt,
        delayMinutes: medicationReminderOccurrence.delayMinutes,
        completionClassification: medicationReminderOccurrence.completionClassification,
        skipReason: medicationReminderOccurrence.skipReason,
        createdAt: medicationReminderOccurrence.createdAt,
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
        isOverdue: medicationReminderOccurrence.isOverdue,
      })
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminder.id, medicationReminderOccurrence.reminderId),
      )
      .innerJoin(medication, eq(medication.id, medicationReminder.medicationId))
      .where(and(...conditions))
      .orderBy(sort?.sortOrder === "desc" ? desc(sortColumn) : asc(sortColumn))
      .limit(limit)
      .offset(offset);

    return {
      occurrences,
      pagination: {
        pageNumber: page,
        pageLimit: limit,
        totalRecords,
        totalPages,
      },
    };
  }

  async update(id, payload, tx = db) {
    const client = tx || db;
    const finalPayload = {
      ...payload,
      updatedAt: new Date(),
    };
    if (payload.status === reminderOccurrenceStatus.COMPLETED && payload.isOverdue === undefined) {
      finalPayload.isOverdue = false;
    }

    const result = await client
      .update(medicationReminderOccurrence)
      .set(finalPayload)
      .where(
        and(
          eq(medicationReminderOccurrence.id, id),
          eq(medicationReminderOccurrence.softDelete, false),
        ),
      )
      .returning();

    return result[0] || null;
  }

  async softDeleteByReminderId(reminderId) {
    return db
      .update(medicationReminderOccurrence)
      .set({
        softDelete: true,
        updatedAt: new Date(),
      })
      .where(eq(medicationReminderOccurrence.reminderId, reminderId));
  }

  async deletePendingOccurrences(reminderId) {
    return db
      .delete(medicationReminderOccurrence)
      .where(
        and(
          eq(medicationReminderOccurrence.reminderId, reminderId),
          eq(medicationReminderOccurrence.status, reminderOccurrenceStatus.PENDING),
        ),
      );
  }
  async findLastOccurrenceByReminderId(reminderId) {
    const result = await db
      .select()
      .from(medicationReminderOccurrence)
      .where(
        and(
          eq(medicationReminderOccurrence.reminderId, reminderId),
          eq(medicationReminderOccurrence.softDelete, false),
        ),
      )
      .orderBy(desc(medicationReminderOccurrence.actualMedicationTime))
      .limit(1);

    return result[0] || null;
  }

  async softDeletePendingOccurrences(reminderId) {
    return db
      .update(medicationReminderOccurrence)
      .set({
        softDelete: true,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(medicationReminderOccurrence.reminderId, reminderId),
          eq(medicationReminderOccurrence.softDelete, false),
          eq(medicationReminderOccurrence.status, reminderOccurrenceStatus.PENDING),
        ),
      );
  }

  async getMedicationSummary(userId, filters = {}) {
    const tz = isValidTimezone(filters.timezone) ? filters.timezone : "Asia/Kolkata";
    const conditions = [
      eq(medicationReminderOccurrence.patientId, userId),
      eq(medicationReminderOccurrence.softDelete, false),
      eq(medicationReminder.softDelete, false),
      eq(medication.softDelete, false),
      sql`${medicationReminderOccurrence.status} != ${reminderOccurrenceStatus.CANCELLED}`,
    ];
    // Single specific date when startDate and endDate are same
    if (filters.startDate && filters.endDate && filters.startDate === filters.endDate) {
      conditions.push(
        sql`(${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date = ${filters.startDate}`,
      );
    } else {
      if (filters.startDate) {
        conditions.push(
          sql`(${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date >= ${filters.startDate}`,
        );
      }

      if (filters.endDate) {
        conditions.push(
          sql`(${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date <= ${filters.endDate}`,
        );
      }
    }

    const result = await db
      .select({
        total: sql`COUNT(*)`.mapWith(Number),
        totalScheduled: sql`COUNT(*)`.mapWith(Number),

        pending: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'PENDING'
            AND (${medicationReminderOccurrence.isOverdue} = false OR ${medicationReminderOccurrence.isOverdue} IS NULL)
            AND (${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::timestamp >= (NOW() AT TIME ZONE ${tz})::timestamp
            THEN 1
          END
        )
      `.mapWith(Number),

        overdue: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'PENDING'
            AND (
              ${medicationReminderOccurrence.isOverdue} = true
              OR (${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::timestamp < (NOW() AT TIME ZONE ${tz})::timestamp
            )
            THEN 1
          END
        )
      `.mapWith(Number),

        totalOutstanding: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'PENDING'
            THEN 1
          END
        )
      `.mapWith(Number),

        completed: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'COMPLETED'
            THEN 1
          END
        )
      `.mapWith(Number),

        completedEarly: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'COMPLETED'
            AND (
              ${medicationReminderOccurrence.completionClassification} = 'EARLY'
              OR (
                ${medicationReminderOccurrence.completionClassification} = 'ON_TIME'
                AND ${medicationReminderOccurrence.delayMinutes} IS NOT NULL
                AND ${medicationReminderOccurrence.delayMinutes} < -5
              )
              OR (
                ${medicationReminderOccurrence.completionClassification} IS NULL
                AND ${medicationReminderOccurrence.completedAt} IS NOT NULL
                AND ${medicationReminderOccurrence.actualMedicationTime} IS NOT NULL
                AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) < -5
              )
            )
            THEN 1
          END
        )
      `.mapWith(Number),

        completedOnTime: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'COMPLETED'
            AND (
              (
                ${medicationReminderOccurrence.completionClassification} = 'ON_TIME'
                AND (${medicationReminderOccurrence.delayMinutes} IS NULL OR ${medicationReminderOccurrence.delayMinutes} >= -5)
              )
              OR (
                ${medicationReminderOccurrence.completionClassification} IS NULL
                AND ${medicationReminderOccurrence.completedAt} IS NOT NULL
                AND ${medicationReminderOccurrence.actualMedicationTime} IS NOT NULL
                AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) >= -5
                AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) <= 30
              )
            )
            THEN 1
          END
        )
      `.mapWith(Number),

        completedLate: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'COMPLETED'
            AND (
              ${medicationReminderOccurrence.completionClassification} = 'LATE'
              OR (
                ${medicationReminderOccurrence.completionClassification} IS NULL
                AND ${medicationReminderOccurrence.completedAt} IS NOT NULL
                AND ${medicationReminderOccurrence.actualMedicationTime} IS NOT NULL
                AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) > 30
              )
            )
            THEN 1
          END
        )
      `.mapWith(Number),

        completedUnknown: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'COMPLETED'
            AND (
              ${medicationReminderOccurrence.completionClassification} = 'UNKNOWN'
              OR (
                ${medicationReminderOccurrence.completionClassification} IS NULL
                AND (
                  ${medicationReminderOccurrence.completedAt} IS NULL
                  OR ${medicationReminderOccurrence.actualMedicationTime} IS NULL
                )
              )
            )
            THEN 1
          END
        )
      `.mapWith(Number),

        missed: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'PENDING'
            AND (${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date < (NOW() AT TIME ZONE ${tz})::date
            THEN 1
          END
        )
      `.mapWith(Number),

        skipped: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'SKIPPED'
            THEN 1
          END
        )
      `.mapWith(Number),
      })
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminder.id, medicationReminderOccurrence.reminderId),
      )
      .innerJoin(medication, eq(medication.id, medicationReminder.medicationId))
      .where(and(...conditions));

    return (
      result[0] || {
        total: 0,
        totalScheduled: 0,
        pending: 0,
        completed: 0,
        completedOnTime: 0,
        completedLate: 0,
        completedEarly: 0,
        completedUnknown: 0,
        overdue: 0,
        totalOutstanding: 0,
        missed: 0,
        skipped: 0,
      }
    );
  }
  async countCompletedOccurrencesByMedicationId(medicationId) {
    const result = await db
      .select({
        count: sql`COUNT(DISTINCT ${medicationReminderOccurrence.id})`.mapWith(Number),
      })
      .from(medicationReminderOccurrence)
      .where(
        and(
          eq(medicationReminderOccurrence.medicationId, medicationId),
          eq(medicationReminderOccurrence.status, reminderOccurrenceStatus.COMPLETED),
          eq(medicationReminderOccurrence.softDelete, false),
        ),
      );

    return result[0]?.count || 0;
  }

  async findUpcomingOccurrencesByMedicationId(medicationId, fromTime = new Date(), limit = 60) {
    return db
      .select({
        id: medicationReminderOccurrence.id,
        actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
        status: medicationReminderOccurrence.status,
      })
      .from(medicationReminderOccurrence)
      .where(
        and(
          eq(medicationReminderOccurrence.medicationId, medicationId),
          gte(medicationReminderOccurrence.actualMedicationTime, fromTime),
          eq(medicationReminderOccurrence.softDelete, false),
        ),
      )
      .orderBy(asc(medicationReminderOccurrence.actualMedicationTime))
      .limit(limit);
  }

  async markPendingOccurrencesOverdue() {
    const now = new Date();
    const result = await db
      .update(medicationReminderOccurrence)
      .set({
        isOverdue: true,
        updatedAt: now,
      })
      .where(
        and(
          eq(medicationReminderOccurrence.status, reminderOccurrenceStatus.PENDING),
          eq(medicationReminderOccurrence.isOverdue, false),
          eq(medicationReminderOccurrence.softDelete, false),
          lt(medicationReminderOccurrence.actualMedicationTime, now),
        ),
      )
      .returning({ id: medicationReminderOccurrence.id });

    return result.length;
  }

  async getWeeklyAdherenceOccurrences(userId, { startDate, endDate, timezone }) {
    const tz = isValidTimezone(timezone) ? timezone : "Asia/Kolkata";
    return db
      .select({
        date: sql`TO_CHAR((${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC') AT TIME ZONE ${tz}, 'YYYY-MM-DD')`,
        completedEarly: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.COMPLETED}
                AND (
                  ${medicationReminderOccurrence.completionClassification} = 'EARLY'
                  OR (
                    ${medicationReminderOccurrence.completionClassification} = 'ON_TIME'
                    AND ${medicationReminderOccurrence.delayMinutes} IS NOT NULL
                    AND ${medicationReminderOccurrence.delayMinutes} < -5
                  )
                  OR (
                    ${medicationReminderOccurrence.completionClassification} IS NULL
                    AND ${medicationReminderOccurrence.completedAt} IS NOT NULL
                    AND ${medicationReminderOccurrence.actualMedicationTime} IS NOT NULL
                    AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) < -5
                  )
                )
              THEN 1
            END
          )
        `.mapWith(Number),
        completedOnTime: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.COMPLETED}
                AND (
                  (
                    ${medicationReminderOccurrence.completionClassification} = 'ON_TIME'
                    AND (${medicationReminderOccurrence.delayMinutes} IS NULL OR ${medicationReminderOccurrence.delayMinutes} >= -5)
                  )
                  OR (
                    ${medicationReminderOccurrence.completionClassification} IS NULL
                    AND ${medicationReminderOccurrence.completedAt} IS NOT NULL
                    AND ${medicationReminderOccurrence.actualMedicationTime} IS NOT NULL
                    AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) >= -5
                    AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) <= 30
                  )
                )
              THEN 1
            END
          )
        `.mapWith(Number),
        completedLate: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.COMPLETED}
                AND (
                  ${medicationReminderOccurrence.completionClassification} = 'LATE'
                  OR (
                    ${medicationReminderOccurrence.completionClassification} IS NULL
                    AND ${medicationReminderOccurrence.completedAt} IS NOT NULL
                    AND ${medicationReminderOccurrence.actualMedicationTime} IS NOT NULL
                    AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) > 30
                  )
                )
              THEN 1
            END
          )
        `.mapWith(Number),
        completedUnknown: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.COMPLETED}
                AND (
                  ${medicationReminderOccurrence.completionClassification} = 'UNKNOWN'
                  OR (
                    ${medicationReminderOccurrence.completionClassification} IS NULL
                    AND (
                      ${medicationReminderOccurrence.completedAt} IS NULL
                      OR ${medicationReminderOccurrence.actualMedicationTime} IS NULL
                    )
                  )
                )
              THEN 1
            END
          )
        `.mapWith(Number),
        overdue: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.PENDING}
                AND ${medicationReminderOccurrence.isOverdue} = true
                AND (${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date = (NOW() AT TIME ZONE ${tz})::date
              THEN 1
            END
          )
        `.mapWith(Number),
        missed: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.PENDING}
                AND (${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date < (NOW() AT TIME ZONE ${tz})::date
              THEN 1
            END
          )
        `.mapWith(Number),
        pending: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.PENDING}
                AND (${medicationReminderOccurrence.isOverdue} = false OR ${medicationReminderOccurrence.isOverdue} IS NULL)
                AND (${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date >= (NOW() AT TIME ZONE ${tz})::date
              THEN 1
            END
          )
        `.mapWith(Number),
        skipped: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.SKIPPED}
              THEN 1
            END
          )
        `.mapWith(Number),
        total: sql`COUNT(*)`.mapWith(Number),
      })
      .from(medicationReminderOccurrence)
      .where(
        and(
          eq(medicationReminderOccurrence.patientId, userId),
          eq(medicationReminderOccurrence.softDelete, false),
          sql`${medicationReminderOccurrence.status} != ${reminderOccurrenceStatus.CANCELLED}`,
          sql`(${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date >= ${startDate}`,
          sql`(${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date <= ${endDate}`,
        ),
      )
      .groupBy(sql`1`)
      .orderBy(sql`1 ASC`);
  }

  async getMonthlyAdherenceOccurrences(userId, { startDate, endDate, timezone }) {
    const tz = isValidTimezone(timezone) ? timezone : "Asia/Kolkata";
    const result = await db
      .select({
        completedEarly: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.COMPLETED}
                AND (
                  ${medicationReminderOccurrence.completionClassification} = 'EARLY'
                  OR (
                    ${medicationReminderOccurrence.completionClassification} = 'ON_TIME'
                    AND ${medicationReminderOccurrence.delayMinutes} IS NOT NULL
                    AND ${medicationReminderOccurrence.delayMinutes} < -5
                  )
                  OR (
                    ${medicationReminderOccurrence.completionClassification} IS NULL
                    AND ${medicationReminderOccurrence.completedAt} IS NOT NULL
                    AND ${medicationReminderOccurrence.actualMedicationTime} IS NOT NULL
                    AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) < -5
                  )
                )
              THEN 1
            END
          )
        `.mapWith(Number),
        completedOnTime: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.COMPLETED}
                AND (
                  (
                    ${medicationReminderOccurrence.completionClassification} = 'ON_TIME'
                    AND (${medicationReminderOccurrence.delayMinutes} IS NULL OR ${medicationReminderOccurrence.delayMinutes} >= -5)
                  )
                  OR (
                    ${medicationReminderOccurrence.completionClassification} IS NULL
                    AND ${medicationReminderOccurrence.completedAt} IS NOT NULL
                    AND ${medicationReminderOccurrence.actualMedicationTime} IS NOT NULL
                    AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) >= -5
                    AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) <= 30
                  )
                )
              THEN 1
            END
          )
        `.mapWith(Number),
        completedLate: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.COMPLETED}
                AND (
                  ${medicationReminderOccurrence.completionClassification} = 'LATE'
                  OR (
                    ${medicationReminderOccurrence.completionClassification} IS NULL
                    AND ${medicationReminderOccurrence.completedAt} IS NOT NULL
                    AND ${medicationReminderOccurrence.actualMedicationTime} IS NOT NULL
                    AND (EXTRACT(EPOCH FROM (${medicationReminderOccurrence.completedAt} - ${medicationReminderOccurrence.actualMedicationTime})) / 60) > 30
                  )
                )
              THEN 1
            END
          )
        `.mapWith(Number),
        completedUnknown: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.COMPLETED}
                AND (
                  ${medicationReminderOccurrence.completionClassification} = 'UNKNOWN'
                  OR (
                    ${medicationReminderOccurrence.completionClassification} IS NULL
                    AND (
                      ${medicationReminderOccurrence.completedAt} IS NULL
                      OR ${medicationReminderOccurrence.actualMedicationTime} IS NULL
                    )
                  )
                )
              THEN 1
            END
          )
        `.mapWith(Number),
        overdue: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.PENDING}
                AND ${medicationReminderOccurrence.isOverdue} = true
                AND (${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date = (NOW() AT TIME ZONE ${tz})::date
              THEN 1
            END
          )
        `.mapWith(Number),
        missed: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.PENDING}
                AND (${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date < (NOW() AT TIME ZONE ${tz})::date
              THEN 1
            END
          )
        `.mapWith(Number),
        pending: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.PENDING}
                AND (${medicationReminderOccurrence.isOverdue} = false OR ${medicationReminderOccurrence.isOverdue} IS NULL)
                AND (${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date >= (NOW() AT TIME ZONE ${tz})::date
              THEN 1
            END
          )
        `.mapWith(Number),
        skipped: sql`
          COUNT(
            CASE
              WHEN ${medicationReminderOccurrence.status} = ${reminderOccurrenceStatus.SKIPPED}
              THEN 1
            END
          )
        `.mapWith(Number),
        total: sql`COUNT(*)`.mapWith(Number),
      })
      .from(medicationReminderOccurrence)
      .where(
        and(
          eq(medicationReminderOccurrence.patientId, userId),
          eq(medicationReminderOccurrence.softDelete, false),
          sql`${medicationReminderOccurrence.status} != ${reminderOccurrenceStatus.CANCELLED}`,
          sql`(${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date >= ${startDate}`,
          sql`(${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date <= ${endDate}`,
        ),
      );

    return (
      result[0] || {
        completedOnTime: 0,
        completedLate: 0,
        overdue: 0,
        missed: 0,
        pending: 0,
        skipped: 0,
        total: 0,
      }
    );
  }

  async getDailyOccurrencesWithDetails(userId, { dateStr, timezone }) {
    const tz = isValidTimezone(timezone) ? timezone : "Asia/Kolkata";
    return db
      .select({
        occurrenceId: medicationReminderOccurrence.id,
        medicationId: medicationReminderOccurrence.medicationId,
        reminderId: medicationReminderOccurrence.reminderId,
        status: medicationReminderOccurrence.status,
        actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
        completedAt: medicationReminderOccurrence.completedAt,
        delayMinutes: medicationReminderOccurrence.delayMinutes,
        completionClassification: medicationReminderOccurrence.completionClassification,
        isOverdue: medicationReminderOccurrence.isOverdue,
        skipReason: medicationReminderOccurrence.skipReason,
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
        dosePerIntake: medication.dosePerIntake,
        unit: medication.unit,
      })
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminder.id, medicationReminderOccurrence.reminderId),
      )
      .innerJoin(medication, eq(medication.id, medicationReminder.medicationId))
      .where(
        and(
          eq(medicationReminder.patientId, userId),
          eq(medicationReminderOccurrence.softDelete, false),
          sql`(${medicationReminderOccurrence.actualMedicationTime} AT TIME ZONE 'UTC' AT TIME ZONE ${tz})::date = ${dateStr}`,
        ),
      )
      .orderBy(asc(medicationReminderOccurrence.actualMedicationTime));
  }
}

module.exports = new MedicationReminderOccurrenceRepository();
