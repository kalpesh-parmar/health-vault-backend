const { eq, and, sql, gte, lte, asc, desc } = require("drizzle-orm");
const { db } = require("../configs/db");
const { medicationReminderOccurrence } = require("../models/medicationReminderOccurrence");
const { medicationReminder } = require("../models/medicationReminder");
const { medication } = require("../models/medication");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
class MedicationReminderOccurrenceRepository {
  async bulkCreate(payload) {
    return db.insert(medicationReminderOccurrence).values(payload).returning();
  }
  async findById(id) {
    const result = await db
      .select()
      .from(medicationReminderOccurrence)
      .where(
        and(
          eq(medicationReminderOccurrence.id, id),
          eq(medicationReminderOccurrence.softDelete, false),
        ),
      )
      .limit(1);

    return result[0] || null;
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
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
        isOverdue:
          sql`CASE WHEN ${medicationReminderOccurrence.status} = 'PENDING' AND ${medicationReminderOccurrence.actualMedicationTime} < NOW() THEN true ELSE false END`.mapWith(
            Boolean,
          ),
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

  async findTodayOccurrences(userId) {
    return db
      .select({
        id: medicationReminderOccurrence.id,
        reminderId: medicationReminderOccurrence.reminderId,
        medicationId: medicationReminderOccurrence.medicationId,
        status: medicationReminderOccurrence.status,
        actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
        completedAt: medicationReminderOccurrence.completedAt,
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

          // only today's date
          sql`DATE(${medicationReminderOccurrence.actualMedicationTime}) = CURRENT_DATE`,
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

  async update(id, payload) {
    const result = await db
      .update(medicationReminderOccurrence)
      .set({
        ...payload,
        updatedAt: new Date(),
      })
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
    const conditions = [
      eq(medicationReminderOccurrence.patientId, userId),
      eq(medicationReminderOccurrence.softDelete, false),
    ];
    // Single specific date when startDate and endDate are same
    if (filters.startDate && filters.endDate && filters.startDate === filters.endDate) {
      conditions.push(
        sql`DATE(${medicationReminderOccurrence.actualMedicationTime}) = ${filters.startDate}`,
      );
    } else {
      if (filters.startDate) {
        conditions.push(
          gte(medicationReminderOccurrence.actualMedicationTime, new Date(`${filters.startDate}`)),
        );
      }

      if (filters.endDate) {
        conditions.push(
          lte(medicationReminderOccurrence.actualMedicationTime, new Date(`${filters.endDate}`)),
        );
      }
    }

    const result = await db
      .select({
        total: sql`COUNT(*)`.mapWith(Number),

        pending: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.status} = 'PENDING'
            AND ${medicationReminderOccurrence.actualMedicationTime} >= NOW()
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

        overdue: sql`
        COUNT(
          CASE
            WHEN ${medicationReminderOccurrence.isOverdue} = true 
            THEN 1
          END
        )
      `.mapWith(Number),
      })
      .from(medicationReminderOccurrence)
      .where(and(...conditions));

    return (
      result[0] || {
        total: 0,
        pending: 0,
        completed: 0,
        overdue: 0,
      }
    );
  }
}

module.exports = new MedicationReminderOccurrenceRepository();
