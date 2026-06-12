const { errorConstants } = require("../constants/errorConstants");
const { NotFoundException } = require("../exceptions/appError");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const medicationRepository = require("../repositories/medicationRepository");
const medicationReminderRepository = require("../repositories/medicationReminderRepository");
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const { generateReminderOccurrences } = require("../utils/reminderOccurrenceGenerator");
const {
  validateSchema,
  createReminderSchema,
  updateOccurrenceSchema,
  listOccurrencesQuerySchema,
} = require("../validations");
class MedicationReminderService {
  //create
  async createReminder(userId, data) {
    // VALIDATE REQUEST
    const validData = await validateSchema(createReminderSchema, data);
    // VALIDATE MEDICATION OWNERSHIP
    const medication = await this.validateMedicationOwnership(validData.medicationId, userId);
    // CREATE MAIN REMINDER
    const reminder = await medicationReminderRepository.create({
      patientId: userId,
      medicationId: medication.id,
      reminderBeforeMinutes: medication.reminderBeforeMinutes,
      dosePerIntake: medication.dosePerIntake,
      // routineBase: medication.frequency,
      // medicationTime: medication.medicationTime,
    });

    // GENERATE OCCURRENCES (with skipPastOccurrences: true)
    const occurrences = generateReminderOccurrences(reminder, medication, null, {
      skipPastOccurrences: true,
    });

    // BULK CREATE OCCURRENCES
    if (occurrences.length > 0) {
      await medicationReminderOccurrenceRepository.bulkCreate(occurrences);

      // Recalculate end date and refill reminder time based on the actual generated occurrences
      const recalculatedEndDate = occurrences[occurrences.length - 1].actualMedicationTime;
      // const endDateOnly = recalculatedEndDate.toISOString().split("T")[0];
      await medicationRepository.updateById(medication.id, {
        endDate: recalculatedEndDate,
      });
    }

    return reminder;
  }
  //get all reminders
  async getAllReminders(userId) {
    return medicationReminderRepository.findAll(userId);
  }
  //get all sub remiders
  async getAllOccurrences(userId) {
    return medicationReminderOccurrenceRepository.findAllOccurrences(userId);
  }

  // get today occurrences
  async getTodayOccurrences(userId) {
    return medicationReminderOccurrenceRepository.findTodayOccurrences(userId);
  }

  //filter
  async getOccurrences(userId, data) {
    const filters = await validateSchema(listOccurrencesQuerySchema, data);
    return medicationReminderOccurrenceRepository.getOccurrences(userId, filters);
  }
  // UPDATE OCCURRENCE
  async updateOccurrence(id, userId, data) {
    const validData = await validateSchema(updateOccurrenceSchema, data);
    const occurrence = await medicationReminderOccurrenceRepository.findById(id);

    if (!occurrence || String(occurrence.patientId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_OCCURRENCE_NOT_FOUND);
    }

    // ALREADY COMPLETED
    if (occurrence.status === reminderOccurrenceStatus.COMPLETED) {
      throw new NotFoundException(errorConstants.MEDICATION_OCCURRENCE_ALREADY_COMPLETED);
    }
    //do not allow future reminders to be completed
    if (validData.status === reminderOccurrenceStatus.COMPLETED) {
      const occurrenceDate = new Date(occurrence.actualMedicationTime);
      const today = new Date();
      occurrenceDate.setHours(0, 0, 0, 0);
      today.setHours(0, 0, 0, 0);
      if (occurrenceDate > today) {
        throw new NotFoundException(errorConstants.FUTURE_REMINDER_CANNOT_BE_COMPLETED);
      }
    }

    const updatePayload = {
      status: validData.status,
      completedAt: validData.status === reminderOccurrenceStatus.COMPLETED ? new Date() : null,
    };

    await medicationReminderOccurrenceRepository.update(id, updatePayload);
    return true;
  }

  //delete reminder
  async deleteReminder(id, userId) {
    const reminder = await medicationReminderRepository.findById(id);

    if (!reminder || String(reminder.patientId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_REMINDER_NOT_FOUND);
    }
    // SOFT DELETE MAIN REMINDER
    await medicationReminderRepository.softDelete(id);
    // SOFT DELETE OCCURRENCES
    await medicationReminderOccurrenceRepository.softDeleteByReminderId(id);
    return true;
  }

  //validated mediction ownship
  async validateMedicationOwnership(medicationId, userId) {
    const medication = await medicationRepository.findById(medicationId);

    if (!medication || String(medication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    return medication;
  }

  // MEDICATION SUMMARY
  async getMedicationSummary(userId, filters = {}) {
    if (!userId) {
      throw new NotFoundException(errorConstants.USER_NOT_FOUND);
    }
    return medicationReminderOccurrenceRepository.getMedicationSummary(userId, filters);
  }
}

module.exports = new MedicationReminderService();
