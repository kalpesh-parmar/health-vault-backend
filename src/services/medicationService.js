const { errorConstants } = require("../constants/errorConstants");
const { NotFoundException } = require("../exceptions/appError");
const medicationRepository = require("../repositories/medicationRepository");
const patientRepository = require("../repositories/patientRepository");
const medicationReminderRepository = require("../repositories/medicationReminderRepository");
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const {
  createMedicationSchema,
  updateMedicationSchema,
  listMedicationQuerySchema,
  validateSchema,
} = require("../validations");
const { calculateMedicationValues } = require("../utils/medicationCalculation");
const { reminderType } = require("../enums/reminderType");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");

class MedicationService {
  // CREATE MEDICATION
  async createMedication(userId, payload) {
    const validData = await validateSchema(createMedicationSchema, payload);
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }
    const { endDate, remainingQuantity, dailyConsumption } = calculateMedicationValues(validData);
    const medication = await medicationRepository.create({
      userId,
      patientCode: patient.patientCode,
      ...validData,
      endDate,
      remainingQuantity,
      dailyConsumption,
    });
    // CREATE REMINDER
    const reminder = await medicationReminderRepository.create({
      patientId: userId,
      medicationId: medication.id,
      type: reminderType.BEFORE_MEDICATION,
      reminderBeforeMinutes: 5,
      afterReminderMinutes: 10,
      refillAlertBeforeDays: 1,
      dosePerIntake: medication.dosePerIntake,
      frequency: medication.frequency,
      medicationTime: medication.medicationTime,
      active: true,
    });
    // GENERATE OCCURRENCES
    const occurrences = [];
    const medicationTimes = medication.medicationTime || [];
    const startDate = new Date(medication.startDate);
    const finalDate = new Date(medication.endDate);
    while (startDate <= finalDate) {
      for (const timeObj of medicationTimes) {
        const [hours, minutes] = timeObj.time.split(":");
        // MEDICATION TIME
        const medicationDateTime = new Date(startDate);
        medicationDateTime.setHours(Number(hours));
        medicationDateTime.setMinutes(Number(minutes));
        medicationDateTime.setSeconds(0);
        // BEFORE REMINDER
        occurrences.push({
          reminderId: reminder.id,
          type: reminderType.BEFORE_MEDICATION,
          status: reminderOccurrenceStatus.PENDING,
          scheduledAt: new Date(medicationDateTime.getTime() - 5 * 60000),
          actualMedicationTime: medicationDateTime,
        });
        // AFTER REMINDER
        occurrences.push({
          reminderId: reminder.id,
          type: reminderType.AFTER_MEDICATION,
          status: reminderOccurrenceStatus.PENDING,
          scheduledAt: new Date(medicationDateTime.getTime() + 10 * 60000),
          actualMedicationTime: medicationDateTime,
        });
      }
      // NEXT DAY
      startDate.setDate(startDate.getDate() + 1);
    }
    // SAVE OCCURRENCES
    if (occurrences.length) {
      await medicationReminderOccurrenceRepository.bulkCreate(occurrences);
    }
    return medication;
  }

  // UPDATE MEDICATION
  async updateMedication(id, userId, payload) {
    const validData = await validateSchema(updateMedicationSchema, payload);
    const existingMedication = await medicationRepository.findById(id);
    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }
    const updatedPayload = {
      ...existingMedication,

      ...validData,
    };
    const { endDate, remainingQuantity, dailyConsumption, unit } =
      calculateMedicationValues(updatedPayload);
    const updatedMedication = await medicationRepository.updateById(id, {
      ...validData,
      endDate,
      remainingQuantity,
      dailyConsumption,
      unit,
    });
    const reminder = await medicationReminderRepository.findByMedicationId(id);
    if (reminder) {
      //UPDATE REMINDER
      await medicationReminderRepository.updateById(reminder.id, {
        dosePerIntake: updatedMedication.dosePerIntake,
        frequency: updatedMedication.frequency,
        medicationTime: updatedMedication.medicationTime,
      });
      // SOFT DELETE OLD OCCURRENCES
      await medicationReminderOccurrenceRepository.softDeleteByReminderId(reminder.id);
      // REGENERATE OCCURRENCES
      const occurrences = [];
      const medicationTimes = updatedMedication.medicationTime || [];
      const startDate = new Date(updatedMedication.startDate);
      const finalDate = new Date(updatedMedication.endDate);

      while (startDate <= finalDate) {
        for (const timeObj of medicationTimes) {
          const [hours, minutes] = timeObj.time.split(":");
          const medicationDateTime = new Date(startDate);
          medicationDateTime.setHours(Number(hours));
          medicationDateTime.setMinutes(Number(minutes));
          medicationDateTime.setSeconds(0);
          // BEFORE
          occurrences.push({
            reminderId: reminder.id,
            type: reminderType.BEFORE_MEDICATION,
            status: reminderOccurrenceStatus.PENDING,
            scheduledAt: new Date(medicationDateTime.getTime() - 5 * 60000),
            actualMedicationTime: medicationDateTime,
          });

          occurrences.push({
            reminderId: reminder.id,
            type: reminderType.AFTER_MEDICATION,
            status: reminderOccurrenceStatus.PENDING,
            scheduledAt: new Date(medicationDateTime.getTime() + 10 * 60000),
            actualMedicationTime: medicationDateTime,
          });
        }
        // NEXT DAY
        startDate.setDate(startDate.getDate() + 1);
      }
      // SAVE OCCURRENCES
      if (occurrences.length) {
        await medicationReminderOccurrenceRepository.bulkCreate(occurrences);
      }
    }
    return updatedMedication;
  }
  // GET MEDICATION BY ID
  async getMedicationById(id, userId) {
    const existingMedication = await medicationRepository.findById(id);

    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    return existingMedication;
  }

  // GET MEDICATION LIST
  async getMedicationList(userId) {
    return medicationRepository.findAll(userId);
  }

  // FILTER LIST
  async listMedications(payload, userId) {
    const filters = await validateSchema(listMedicationQuerySchema, payload || {});

    return medicationRepository.findAllWithFilters({
      ...filters,

      userId,
    });
  }

  // PAGINATION LIST
  async listMedicationsPaginated(payload, userId) {
    if (!userId) {
      throw new NotFoundException(errorConstants.USER_NOT_FOUND);
    }

    const filters = await validateSchema(listMedicationQuerySchema, payload);

    return medicationRepository.findAllWithPagination({
      ...filters,

      userId,
    });
  }

  // DELETE MEDICATION
  async deleteMedication(id, userId) {
    // FIND MEDICATION
    const existingMedication = await medicationRepository.findById(id);
    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }
    // SOFT DELETE MEDICATION
    await medicationRepository.softDeleteById(id);
    // FIND REMINDER
    const reminder = await medicationReminderRepository.findByMedicationId(id);
    if (reminder) {
      // SOFT DELETE REMINDER
      await medicationReminderRepository.softDelete(reminder.id);
      // SOFT DELETE OCCURRENCES
      await medicationReminderOccurrenceRepository.softDeleteByReminderId(reminder.id);
    }

    return true;
  }
}

module.exports = new MedicationService();
