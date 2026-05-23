const { errorConstants } = require("../constants/errorConstants");
const { reminderType } = require("../enums/reminderType");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const { NotFoundException } = require("../exceptions/appError");
const medicationRepository = require("../repositories/medicationRepository");
const medicationReminderRepository = require("../repositories/medicationReminderRepository");
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const {
  validateSchema,
  createReminderSchema,
  completeReminderSchema,
  missedReminderSchema,
  skippedReminderSchema,
  snoozeReminderSchema,
  completeRefillAlertSchema,
  snoozeRefillAlertSchema,
  idParamSchema,
} = require("../validations");

class MedicationReminderService {
  // CREATE REMINDER
  async createReminder(userId, payload) {
    const validData = await validateSchema(createReminderSchema, payload);
    const medication = await this.validateMedicationOwnership(validData.medicationId, userId);
    // CREATE MAIN REMINDER
    const reminder = await medicationReminderRepository.create({
      patientId: userId,
      medicationId: medication.id,
      type: reminderType.BEFORE_MEDICATION,
      reminderBeforeMinutes: validData.reminderBeforeMinutes || 5,
      afterReminderMinutes: validData.afterReminderMinutes || 10,
      refillAlertBeforeDays: validData.refillAlertBeforeDays || 1,
      dosePerIntake: medication.dosePerIntake,
      frequency: medication.frequency,
      medicationTime: medication.medicationTime,
      active: true,
    });

    // GENERATE OCCURRENCES
    const occurrences = this.generateOccurrences(reminder, medication);
    // SAVE OCCURRENCES
    if (occurrences.length) {
      await medicationReminderOccurrenceRepository.bulkCreate(occurrences);
    }
    return reminder;
  }

  // GET ALL REMINDERS
  async getAllReminders(userId) {
    return medicationReminderRepository.findAll(userId);
  }

  // GET REMINDER BY ID
  async getReminderById(id, userId) {
    const params = await validateSchema(idParamSchema, { id });
    const reminder = await medicationReminderOccurrenceRepository.findById(params.id);
    if (!reminder || String(reminder.medication_reminders.patientId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_REMINDER_NOT_FOUND);
    }
    return reminder;
  }

  // DELETE REMINDER
  async deleteReminder(id, userId) {
    const params = await validateSchema(idParamSchema, { id });
    const reminder = await medicationReminderRepository.findById(params.id);
    if (!reminder || String(reminder.patientId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_REMINDER_NOT_FOUND);
    }
    // SOFT DELETE MAIN REMINDER
    await medicationReminderRepository.softDelete(params.id);
    // SOFT DELETE OCCURRENCES
    await medicationReminderOccurrenceRepository.softDeleteByReminderId(params.id);

    return true;
  }

  // GET TODAY OCCURRENCES
  async getTodayOccurrences(userId) {
    return medicationReminderOccurrenceRepository.findTodayOccurrences(userId);
  }

  // COMPLETE REMINDER
  async completeReminder(occurrenceId, userId, payload) {
    await validateSchema(idParamSchema, { id: occurrenceId });
    const validData = await validateSchema(completeReminderSchema, payload);
    const occurrence = await medicationReminderOccurrenceRepository.findById(occurrenceId);
    if (!occurrence || String(occurrence.medicationReminder.patientId) !== String(userId)) {
      throw new NotFoundException(errorConstants.REMINDER_OCCURRENCE_NOT_FOUND);
    }

    // COMPLETE REMINDER
    await medicationReminderOccurrenceRepository.completeReminder(occurrenceId, {
      ...validData,
      completedAt: new Date(),
    });

    // REDUCE MEDICATION QUANTITY
    const medicationId = occurrence.medicationReminder.medicationId;
    const dose = occurrence.medicationReminder.dosePerIntake || 1;
    await medicationRepository.reduceQuantity(medicationId, dose);
    return true;
  }
  // MARK AS MISSED
  async missedReminder(occurrenceId, payload) {
    await validateSchema(idParamSchema, { id: occurrenceId });
    await validateSchema(missedReminderSchema, payload);
    await medicationReminderOccurrenceRepository.updateStatus(
      occurrenceId,
      reminderOccurrenceStatus.MISSED,
      {
        missedAt: new Date(),
      },
    );

    return true;
  }

  // MARK AS SKIPPED
  async skippedReminder(occurrenceId, payload) {
    await validateSchema(idParamSchema, { id: occurrenceId });
    await validateSchema(skippedReminderSchema, payload);
    await medicationReminderOccurrenceRepository.updateStatus(
      occurrenceId,
      reminderOccurrenceStatus.SKIPPED,
      {
        skippedAt: new Date(),
      },
    );

    return true;
  }

  // SNOOZE REMINDER
  async snoozeReminder(occurrenceId, userId, payload) {
    await validateSchema(idParamSchema, { id: occurrenceId });
    const validData = await validateSchema(snoozeReminderSchema, payload);
    const snoozeUntil = new Date(Date.now() + validData.minutes * 60000);
    await medicationReminderOccurrenceRepository.updateStatus(
      occurrenceId,
      reminderOccurrenceStatus.SNOOZED,
      {
        snoozeUntil,
        snoozeCount: 1,
      },
    );

    return true;
  }

  // GET REFILL ALERTS
  async getRefillAlerts(userId) {
    return medicationReminderOccurrenceRepository.findRefillAlerts(userId);
  }
  // GET TODAY REFILL ALERTS
  async getTodayRefillAlerts(userId) {
    return medicationReminderOccurrenceRepository.findTodayRefillAlerts(userId);
  }

  // COMPLETE REFILL ALERT
  async completeRefillAlert(occurrenceId, payload) {
    await validateSchema(idParamSchema, { id: occurrenceId });
    await validateSchema(completeRefillAlertSchema, payload);
    await medicationReminderOccurrenceRepository.updateStatus(
      occurrenceId,
      reminderOccurrenceStatus.COMPLETED,
      {
        completedAt: new Date(),
      },
    );

    return true;
  }

  // SNOOZE REFILL ALERT
  async snoozeRefillAlert(occurrenceId, userId, payload) {
    await validateSchema(idParamSchema, { id: occurrenceId });
    const validData = await validateSchema(snoozeRefillAlertSchema, payload);
    const snoozeUntil = new Date(Date.now() + validData.minutes * 60000);
    await medicationReminderOccurrenceRepository.updateStatus(
      occurrenceId,
      reminderOccurrenceStatus.SNOOZED,
      {
        snoozeUntil,
      },
    );

    return true;
  }

  // VALIDATE MEDICATION OWNERSHIP
  async validateMedicationOwnership(medicationId, userId) {
    const medication = await medicationRepository.findById(medicationId);

    if (!medication || String(medication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    return medication;
  }

  // GENERATE OCCURRENCES
  generateOccurrences(reminder, medication) {
    const occurrences = [];
    const medicationTimes = medication.medicationTime || [];
    const currentDate = new Date(medication.startDate);
    const endDate = new Date(medication.endDate);
    while (currentDate <= endDate) {
      for (const timeObj of medicationTimes) {
        const [hours, minutes] = timeObj.time.split(":");

        // ACTUAL MEDICATION TIME
        const medicationDateTime = new Date(currentDate);

        medicationDateTime.setHours(Number(hours));
        medicationDateTime.setMinutes(Number(minutes));
        medicationDateTime.setSeconds(0);

        // BEFORE REMINDER
        const beforeTime = new Date(
          medicationDateTime.getTime() - reminder.reminderBeforeMinutes * 60000,
        );

        occurrences.push({
          reminderId: reminder.id,
          type: reminderType.BEFORE_MEDICATION,
          status: reminderOccurrenceStatus.PENDING,
          scheduledAt: beforeTime,
          actualMedicationTime: medicationDateTime,
        });

        // AFTER REMINDER
        const afterTime = new Date(
          medicationDateTime.getTime() + reminder.afterReminderMinutes * 60000,
        );

        occurrences.push({
          reminderId: reminder.id,
          type: reminderType.AFTER_MEDICATION,
          status: reminderOccurrenceStatus.PENDING,
          scheduledAt: afterTime,
          actualMedicationTime: medicationDateTime,
        });
      }

      currentDate.setDate(currentDate.getDate() + 1);
    }

    // REFILL ALERT
    if (medication.refillAlert) {
      const refillDate = new Date(medication.endDate);

      refillDate.setDate(refillDate.getDate() - reminder.refillAlertBeforeDays);

      refillDate.setHours(9);
      refillDate.setMinutes(0);
      refillDate.setSeconds(0);

      occurrences.push({
        reminderId: reminder.id,
        type: reminderType.REFILL_ALERT,
        status: reminderOccurrenceStatus.PENDING,
        scheduledAt: refillDate,
      });
    }

    return occurrences;
  }
}

module.exports = new MedicationReminderService();
