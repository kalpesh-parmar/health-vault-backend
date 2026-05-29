const { eq, and, sql, gte, lte, asc, desc } = require("drizzle-orm");
const { db } = require("../configs/db");
const { medicationReminderOccurrence } = require("../models/medicationReminderOccurrence");
const { medicationReminder } = require("../models/medicationReminder");
const { medication } = require("../models/medication");

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
        beforeReminderTime: medicationReminderOccurrence.beforeReminderTime,
        afterReminderTime: medicationReminderOccurrence.afterReminderTime,
        completedAt: medicationReminderOccurrence.completedAt,
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
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
        beforeReminderTime: medicationReminderOccurrence.beforeReminderTime,
        afterReminderTime: medicationReminderOccurrence.afterReminderTime,
        completedAt: medicationReminderOccurrence.completedAt,
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
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
    const { status, startDate, endDate, medicationName, medicationType, date } = filter;
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
    const sortFieldMap = {
      actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
      completedAt: medicationReminderOccurrence.completedAt,
      createdAt: medicationReminderOccurrence.createdAt,
      status: medicationReminderOccurrence.status,
    };

    const sortColumn =
      sortFieldMap[sort?.sortBy] || medicationReminderOccurrence.actualMedicationTime;

    return db
      .select({
        id: medicationReminderOccurrence.id,
        reminderId: medicationReminderOccurrence.reminderId,
        medicationId: medicationReminderOccurrence.medicationId,
        status: medicationReminderOccurrence.status,
        actualMedicationTime: medicationReminderOccurrence.actualMedicationTime,
        beforeReminderTime: medicationReminderOccurrence.beforeReminderTime,
        afterReminderTime: medicationReminderOccurrence.afterReminderTime,
        completedAt: medicationReminderOccurrence.completedAt,
        notificationSent: medicationReminderOccurrence.notificationSent,
        notificationSentAt: medicationReminderOccurrence.notificationSentAt,
        createdAt: medicationReminderOccurrence.createdAt,
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
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
}

module.exports = new MedicationReminderOccurrenceRepository();
