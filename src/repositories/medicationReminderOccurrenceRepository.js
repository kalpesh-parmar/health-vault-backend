const { eq, and, lte, or, sql } = require("drizzle-orm");
const { db } = require("../configs/db");
const { medicationReminderOccurrence } = require("../models/medicationReminderOccurrence");
const { medicationReminder } = require("../models/medicationReminder");
const { reminderType } = require("../enums/reminderType");

class MedicationReminderOccurrenceRepository {
  // BULK CREATE
  async bulkCreate(payload) {
    return db.insert(medicationReminderOccurrence).values(payload).returning();
  }

  // FIND BY ID
  async findById(id) {
    const result = await db
      .select()
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminderOccurrence.reminderId, medicationReminder.id),
      )
      .where(
        and(
          eq(medicationReminderOccurrence.id, id),
          eq(medicationReminderOccurrence.softDelete, false),
        ),
      );

    return result[0];
  }
  // UPDATE STATUS
  async updateStatus(id, status, extra = {}) {
    return db
      .update(medicationReminderOccurrence)
      .set({
        status,

        updatedAt: new Date(),

        ...extra,
      })
      .where(eq(medicationReminderOccurrence.id, id));
  }
  // TODAY OCCURRENCES
  async findTodayOccurrences(userId) {
    return db
      .select()
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminder.id, medicationReminderOccurrence.reminderId),
      )
      .where(
        and(
          eq(medicationReminder.patientId, userId),

          // occurrence not deleted
          eq(medicationReminderOccurrence.softDelete, false),

          // main reminder not deleted
          eq(medicationReminder.softDelete, false),

          sql`
          DATE(${medicationReminderOccurrence.scheduledAt})
          =
          CURRENT_DATE
        `,
        ),
      );
  }
  // REFILL ALERTS
  async findRefillAlerts(userId) {
    return db
      .select()
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,

        eq(
          medicationReminder.id,

          medicationReminderOccurrence.reminderId,
        ),
      )
      .where(
        and(
          eq(medicationReminder.patientId, userId),

          eq(medicationReminderOccurrence.type, reminderType.REFILL_ALERT),

          eq(medicationReminderOccurrence.softDelete, false),
        ),
      );
  }
  // TODAY REFILL ALERTS
  async findTodayRefillAlerts(userId) {
    return db
      .select()
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,

        eq(
          medicationReminder.id,

          medicationReminderOccurrence.reminderId,
        ),
      )
      .where(
        and(
          eq(medicationReminder.patientId, userId),

          eq(medicationReminderOccurrence.type, reminderType.REFILL_ALERT),

          eq(medicationReminderOccurrence.softDelete, false),

          sql`
            DATE(${medicationReminderOccurrence.scheduledAt})
            =
            CURRENT_DATE
          `,
        ),
      );
  }


  // FIND PENDING REMINDERS
  async findPendingReminders(pendingStatuses) {
    return db
      .select()
      .from(medicationReminderOccurrence)
      .where(
        and(
          or(...pendingStatuses.map((status) => eq(medicationReminderOccurrence.status, status))),

          eq(medicationReminderOccurrence.softDelete, false),

          lte(medicationReminderOccurrence.scheduledAt, new Date()),
        ),
      );
  }

  // SOFT DELETE BY REMINDER ID
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
