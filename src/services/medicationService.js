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
const refillCountRepository = require("../repositories/refillCountRepository");
const { calculateRemainingQuantity } = require("../utils/remainingQuantityCalculation");

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
      unit,
      startDate,
    });
    return medication;
  }

  // UPDATE MEDICATION
  async updateMedication(id, userId, payload) {
    // Validate request payload
    const validData = await validateSchema(updateMedicationSchema, payload);

    // Check medication
    const existingMedication = await medicationRepository.findById(id);

    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }

    // Find reminder
    const reminder = await medicationReminderRepository.findByMedicationId(id);

    // Calculate remaining quantity BEFORE update
    let remainingQuantity = await calculateRemainingQuantity(
      existingMedication,
      medicationReminderOccurrenceRepository,
    );

    // If total quantity is updated, recalculate remaining quantity
    if (validData.totalQuantity !== undefined) {
      const completedCount =
        await medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId(id);
      const consumedQuantity = completedCount * Number(existingMedication.dosePerIntake || 1);
      remainingQuantity = Math.max(0, Number(validData.totalQuantity) - consumedQuantity);
    }

    // Merge existing medication with incoming updates
    const updatedPayload = {
      ...existingMedication,
      ...validData,
    };

    // Use updated total quantity if provided
    const totalQuantity =
      validData.totalQuantity !== undefined
        ? Number(validData.totalQuantity)
        : Number(existingMedication.totalQuantity);

    const medicationDataForCalculation = {
      ...updatedPayload,
      totalQuantity,
    };

    // Recalculate medication values
    const { endDate, dailyConsumption, unit } = calculateMedicationValues(
      medicationDataForCalculation,
      new Date(),
    );

    // Update medication
    const updatedMedication = await medicationRepository.updateById(id, {
      ...validData,
      totalQuantity,
      endDate,
      dailyConsumption,
      unit,
    });

    // If medication has no reminder then update is complete
    if (!reminder) {
      return updatedMedication;
    }

    // Update reminder dose if changed
    if (validData.dosePerIntake !== undefined) {
      await medicationReminderRepository.updateById(reminder.id, {
        dosePerIntake: validData.dosePerIntake,
      });
    }

    const updatedReminder = await medicationReminderRepository.findByMedicationId(id);
    // Remove future pending occurrences
    await medicationReminderOccurrenceRepository.deletePendingOccurrences(updatedReminder.id);
    // Get latest medication values after update
    const latestMedication = await medicationRepository.findById(id);
    // Generate future occurrences using updated medication +
    // calculated remaining quantity
    const occurrences = generateReminderOccurrences(
      updatedReminder,
      {
        ...latestMedication,
        remainingQuantity,
      },
      new Date(),
      {
        skipPastOccurrences: true,
      },
    );

    if (occurrences.length) {
      // Create new future occurrences
      await medicationReminderOccurrenceRepository.bulkCreate(occurrences);
      // Update medication end date from generated occurrences
      const recalculatedEndDate = occurrences[occurrences.length - 1].actualMedicationTime;
      await medicationRepository.updateById(id, {
        endDate: recalculatedEndDate,
      });

      updatedMedication.endDate = recalculatedEndDate;
      //   // Update refill reminder time
      //   const { refillTime } = require("../utils/reminderOccurrenceGenerator");
      //   const finalRefillTime = refillTime(recalculatedEndDate);
      //   await medicationReminderRepository.updateById(updatedReminder.id, {
      //     refillReminderTime: finalRefillTime,
      //   });
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

    const currentRemainingQuantity = await calculateRemainingQuantity(
      medication,
      medicationReminderOccurrenceRepository,
    );
    const newRemainingQuantity = Number(currentRemainingQuantity) + Number(quantity);
    const newTotalQuantity = Number(medication.totalQuantity || 0) + Number(quantity);
    // Update quantities in database
    const updatedMedication = await medicationRepository.updateById(id, {
      totalQuantity: newTotalQuantity,
    });

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
    };
    const occurrences = generateReminderOccurrences(reminder, reminderMedication, startFromDate, {
      skipPastOccurrences: true,
    });

    if (occurrences.length) {
      await medicationReminderOccurrenceRepository.bulkCreate(occurrences);

      // Recalculate end date based on actual generated occurrences
      const recalculatedEndDate = occurrences[occurrences.length - 1].actualMedicationTime;
      await medicationRepository.updateById(id, {
        endDate: recalculatedEndDate,
      });
      updatedMedication.endDate = recalculatedEndDate;

      // Update the reminder's refillReminderTime
      // const { refillTime } = require("../utils/reminderOccurrenceGenerator");
      // const finalRefillTime = refillTime(recalculatedEndDate);
      await refillCountRepository.add({
        userId: medication.userId,
        medicationId: medication.id,
        beforeRefillTotalQuantity: medication.totalQuantity,
        beforeRefillRemainingQuantity: currentRemainingQuantity,
        refillQuantity: quantity,
        afterRefillTotalQuantity: newTotalQuantity,
        afterRefillRemainingQuantity: newRemainingQuantity,
      });
      // await medicationReminderRepository.updateById(reminder.id, {
      //   refillReminderTime: finalRefillTime,
      // });
    }

    return updatedMedication;
  }
}

module.exports = new MedicationService();
