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
const generateReminderOccurrences = require("../utils/reminderOccurrenceGenerator");

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

    return medication;
  }

  // UPDATE MEDICATION
  async updateMedication(id, userId, payload) {
    // VALIDATE REQUEST
    const validData = await validateSchema(updateMedicationSchema, payload);
    // FIND MEDICATION
    const existingMedication = await medicationRepository.findById(id);
    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }
    // MERGE UPDATED VALUES
    const updatedPayload = {
      ...existingMedication,
      ...validData,
    };
    // RECALCULATE VALUES
    const { endDate, remainingQuantity, dailyConsumption, unit } =
      calculateMedicationValues(updatedPayload);
    // UPDATE MEDICATION
    const updatedMedication = await medicationRepository.updateById(id, {
      ...validData,
      endDate,
      remainingQuantity,
      dailyConsumption,
      unit,
    });

    const reminder = await medicationReminderRepository.findByMedicationId(id);

    if (reminder) {
      // UPDATE MAIN REMINDER
      await medicationReminderRepository.updateById(reminder.id, {
        dosePerIntake: updatedMedication.dosePerIntake,
        routineBase: updatedMedication.frequency,
        medicationTime: updatedMedication.medicationTime,
        updatedAt: new Date(),
      });

      // SOFT DELETE OLD OCCURRENCES
      await medicationReminderOccurrenceRepository.softDeleteByReminderId(reminder.id);

      // REGENERATE NEW OCCURRENCES
      const occurrences = generateReminderOccurrences(
        {
          ...reminder,
          dosePerIntake: updatedMedication.dosePerIntake,
          routineBase: updatedMedication.frequency,
          medicationTime: updatedMedication.medicationTime,
        },
        updatedMedication,
      );

      // SAVE NEW OCCURRENCES
      if (occurrences.length > 0) {
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
