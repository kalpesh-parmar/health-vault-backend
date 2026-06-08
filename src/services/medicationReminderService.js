const { errorConstants } = require("../constants/errorConstants");
const { NotFoundException } = require("../exceptions/appError");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const medicationRepository = require("../repositories/medicationRepository");
const medicationReminderRepository = require("../repositories/medicationReminderRepository");
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const {
  generateReminderOccurrences,
  refillTime,
} = require("../utils/reminderOccurrenceGenerator");
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
    const refillReminderTime = refillTime(medication.endDate);
    const reminder = await medicationReminderRepository.create({
      patientId: userId,
      medicationId: medication.id,
      reminderBeforeMinutes: medication.reminderBeforeMinutes,
      dosePerIntake: medication.dosePerIntake,
      routineBase: medication.frequency,
      medicationTime: medication.medicationTime,
      refillReminderTime:refillReminderTime,
      
    });

    // GENERATE OCCURRENCES
    const occurrences = generateReminderOccurrences(reminder, medication);

    // BULK CREATE OCCURRENCES
    if (occurrences.length > 0) {
      await medicationReminderOccurrenceRepository.bulkCreate(occurrences);
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
  // UPDATE
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

    const updatePayload = {
      status: validData.status,
      completedAt: validData.status === reminderOccurrenceStatus.COMPLETED ? new Date() : null,
    };

    await medicationReminderOccurrenceRepository.update(id, updatePayload);

    if (validData.status === reminderOccurrenceStatus.COMPLETED) {
      const medication = await medicationRepository.findById(occurrence.medicationId);

      if (medication) {
        await medicationRepository.reduceQuantity(
          occurrence.medicationId,
          medication.dosePerIntake || 1,
        );
      }
    }

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
