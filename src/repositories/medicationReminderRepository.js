const { eq, and, asc } = require("drizzle-orm");
const { db } = require("../configs/db");
const { medicationReminder } = require("../models/medicationReminder");
const { medication } = require("../models/medication");

class MedicationReminderRepository {
  async create(payload) {
    const result = await db.insert(medicationReminder).values(payload).returning();
    return result[0];
  }

  async findAll(userId) {
    return db
      .select({
        id: medicationReminder.id,
        patientId: medicationReminder.patientId,
        medicationId: medicationReminder.medicationId,
        medicationName: medication.medicationName,
        medicationType: medication.medicationType,
        reminderBeforeMinutes: medicationReminder.reminderBeforeMinutes,
        afterReminderMinutes: medicationReminder.afterReminderMinutes,
        refillAlertBeforeDays: medicationReminder.refillAlertBeforeDays,
        dosePerIntake: medicationReminder.dosePerIntake,
        routineBase: medicationReminder.routineBase,
        medicationTime: medicationReminder.medicationTime,
        active: medicationReminder.active,
        createdAt: medicationReminder.createdAt,
        updatedAt: medicationReminder.updatedAt,
      })
      .from(medicationReminder)
      .leftJoin(medication, eq(medicationReminder.medicationId, medication.id))
      .where(
        and(
          eq(medicationReminder.patientId, userId),

          eq(medicationReminder.softDelete, false),
        ),
      )
      .orderBy(asc(medicationReminder.createdAt));
  }

  async findById(id) {
    const result = await db
      .select()
      .from(medicationReminder)
      .where(and(eq(medicationReminder.id, id), eq(medicationReminder.softDelete, false)))
      .limit(1);

    return result[0] || null;
  }

  async updateById(id, payload) {
    const result = await db
      .update(medicationReminder)
      .set({
        ...payload,

        updatedAt: new Date(),
      })
      .where(eq(medicationReminder.id, id))
      .returning();

    return result[0] || null;
  }

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

  async findByMedicationId(medicationId) {
    const result = await db
      .select()
      .from(medicationReminder)
      .where(
        and(
          eq(medicationReminder.medicationId, medicationId),
          eq(medicationReminder.softDelete, false),
        ),
      )
      .limit(1);

    return result[0] || null;
  }
}

module.exports = new MedicationReminderRepository();
