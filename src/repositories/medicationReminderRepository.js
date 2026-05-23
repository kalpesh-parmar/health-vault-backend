const { eq, and } = require("drizzle-orm");
const { db } = require("../configs/db");
const { medicationReminder } = require("../models/medicationReminder");
const { medicationReminderOccurrence } = require("../models/medicationReminderOccurrence");

class MedicationReminderRepository {
  
  // CREATE
  async create(payload) {
    const result = await db.insert(medicationReminder).values(payload).returning();

    return result[0];
  }
  // FIND ALL
  async findAll(userId) {
    return db
      .select()
      .from(medicationReminderOccurrence)
      .innerJoin(
        medicationReminder,
        eq(medicationReminderOccurrence.reminderId, medicationReminder.id),
      )
      .where(
        and(
          eq(medicationReminder.patientId, userId),
          eq(medicationReminderOccurrence.softDelete, false),
        ),
      );
  }
  
  // FIND BY ID
  async findById(id) {
    const result = await db
      .select()
      .from(medicationReminder)
      .where(
        and(
          eq(medicationReminder.id, id),

          eq(medicationReminder.softDelete, false),
        ),
      );

    return result[0];
  }

  // FIND BY MEDICATION ID
  async findByMedicationId(medicationId) {
    const result = await db
      .select()
      .from(medicationReminder)
      .where(
        and(
          eq(medicationReminder.medicationId, medicationId),

          eq(medicationReminder.softDelete, false),
        ),
      );

    return result[0];
  }

  // UPDATE
  async updateById(id, payload) {
    const result = await db
      .update(medicationReminder)
      .set({
        ...payload,

        updatedAt: new Date(),
      })
      .where(eq(medicationReminder.id, id))
      .returning();

    return result[0];
  }

  // SOFT DELETE
  async softDelete(id) {
    return db
      .update(medicationReminder)
      .set({
        active: false,

        softDelete: true,

        updatedAt: new Date(),
      })
      .where(eq(medicationReminder.id, id));
  }
}

module.exports = new MedicationReminderRepository();
