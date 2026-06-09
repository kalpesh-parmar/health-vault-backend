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
  refillMedicationSchema,
  validateSchema,
} = require("../validations");
const { calculateMedicationValues } = require("../utils/medicationCalculation");
const { generateReminderOccurrences } = require("../utils/reminderOccurrenceGenerator");
const refillRepository = require("../repositories/refillRepository");
const { refillTime } = require("../utils/reminderOccurrenceGenerator");

class MedicationService {
  // CREATE MEDICATION
  async createMedication(userId, payload) {
    const validData = await validateSchema(createMedicationSchema, payload);
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const { endDate, dailyConsumption, unit, startDate } = calculateMedicationValues(validData);
    const medication = await medicationRepository.create({
      userId,
      patientCode: patient.patientCode,
      ...validData,
      endDate,
      dailyConsumption,
      remainingQuantity: validData.totalQuantity,
      unit,
      startDate,
    });
    return medication;
  }

  //update medication
  async updateMedication(id, userId, payload) {
    const validData = await validateSchema(updateMedicationSchema, payload);
    const existingMedication = await medicationRepository.findById(id);
    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }
    const reminder = await medicationReminderRepository.findByMedicationId(id);
    const updatedPayload = {
      ...existingMedication,
      ...validData,
    };

    let totalQuantity = Number(existingMedication.totalQuantity);
    let remainingQuantity = Number(existingMedication.remainingQuantity);

    // Calculate consumed quantity based on existing total and remaining values
    const consumedQuantity =
      Number(existingMedication.totalQuantity) - Number(existingMedication.remainingQuantity);

    //new total remaining quantity = total Quantity - consumed quantity
    if (validData.totalQuantity !== undefined) {
      totalQuantity = Number(validData.totalQuantity);
      remainingQuantity = Math.max(0, totalQuantity - consumedQuantity);
    }

    const medicationDataForCalculation = {
      ...updatedPayload,
      totalQuantity,
      remainingQuantity,
    };

    // Recalculate endDate, dailyConsumption and unit based on updated data
    const { endDate, dailyConsumption, unit } = calculateMedicationValues(
      medicationDataForCalculation,
      new Date(),
    );

    const updatedMedication = await medicationRepository.updateById(id, {
      ...validData,
      totalQuantity,
      remainingQuantity,
      endDate,
      dailyConsumption,
      unit,
    });

    if (!reminder) {
      return updatedMedication;
    }
    await medicationReminderRepository.updateById(reminder.id, {
      routineBase: validData.frequency ?? reminder.routineBase,
      medicationTime: validData.medicationTime ?? reminder.medicationTime,
      dosePerIntake: validData.dosePerIntake ?? reminder.dosePerIntake,
      reminderBeforeMinutes: validData.reminderBeforeMinutes ?? reminder.reminderBeforeMinutes,
    });

    const updatedReminder = await medicationReminderRepository.findByMedicationId(id);

    //remove all pending occurrences of the reminder, and generate again based on new medication data and reminder data
    await medicationReminderOccurrenceRepository.softDeletePendingOccurrences(updatedReminder.id);

    //refetch medication to get updated endDate and dailyConsumption values
    const latestMedication = await medicationRepository.findById(id);
    //generate occurrences from current date, so that past reminders will not be generated again
    const occurrences = generateReminderOccurrences(updatedReminder, latestMedication, new Date(), {
      skipPastOccurrences: true,
    });

    if (occurrences.length) {
      await medicationReminderOccurrenceRepository.bulkCreate(occurrences);
      const recalculatedEndDate = occurrences[occurrences.length - 1].actualMedicationTime;
      const endDateOnly = recalculatedEndDate.toISOString().split("T")[0];
      await medicationRepository.updateById(id, {
        endDate: endDateOnly,
      });
      updatedMedication.endDate = recalculatedEndDate;

      // Update the reminder's refillReminderTime
      const finalRefillTime = refillTime(recalculatedEndDate);
      await medicationReminderRepository.updateById(updatedReminder.id, {
        refillReminderTime: finalRefillTime,
      });
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

  // REFILL MEDICATION
  async refillMedication(id, userId, payload) {
    const { quantity } = await validateSchema(refillMedicationSchema, payload);
    const medication = await medicationRepository.findById(id);

    if (!medication || String(medication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    const reminder = await medicationReminderRepository.findByMedicationId(id);

    if (!reminder) {
      throw new NotFoundException(errorConstants.MEDICATION_REMINDER_NOT_FOUND);
    }

    const newRemainingQuantity = Number(medication.remainingQuantity || 0) + Number(quantity);
    const newTotalQuantity = Number(medication.totalQuantity || 0) + Number(quantity);

    // Update quantities in database
    const updatedMedication = await medicationRepository.updateById(id, {
      remainingQuantity: newRemainingQuantity,
      totalQuantity: newTotalQuantity,
    });

    // Find last generated occurrence
    const lastOccurrence =
      await medicationReminderOccurrenceRepository.findLastOccurrenceByReminderId(reminder.id);

    if (!lastOccurrence) {
      return updatedMedication;
    }

    const startFromDate = lastOccurrence.actualMedicationTime;
    startFromDate + 1;

    const reminderMedication = {
      ...updatedMedication,
      remainingQuantity: quantity,
      totalQuantity: quantity,
    }; // Refill should skip past occurrences in case the last occurrence was long ago
    const occurrences = generateReminderOccurrences(reminder, reminderMedication, startFromDate, {
      skipPastOccurrences: true,
    });

    if (occurrences.length) {
      await medicationReminderOccurrenceRepository.bulkCreate(occurrences);

      // Recalculate end date based on actual generated occurrences
      const recalculatedEndDate = occurrences[occurrences.length - 1].actualMedicationTime;
      // const endDateOnly = recalculatedEndDate.toISOString().split("T")[0];
      await medicationRepository.updateById(id, {
        endDate: recalculatedEndDate,
      });
      updatedMedication.endDate = recalculatedEndDate;

      // Update the reminder's refillReminderTime
      const finalRefillTime = refillTime(recalculatedEndDate);
      await refillRepository.add({
        userId: medication.userId,
        medicationId: medication.id,
        beforeRefillTotalQuantity: medication.totalQuantity,
        beforeRefillRemainingQuantity: medication.remainingQuantity,
        refillQuantity: quantity,
        afterRefillTotalQuantity: newTotalQuantity,
        afterRefillRemainingQuantity: newRemainingQuantity,
      });
      await medicationReminderRepository.updateById(reminder.id, {
        refillReminderTime: finalRefillTime,
      });
    }

    return updatedMedication;
  }
}

module.exports = new MedicationService();
