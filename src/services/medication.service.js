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
  medicationOnboardingSchema,
  checkDuplicateMedicationSchema,
  validateSchema,
} = require("../validations");
const { calculateMedicationValues } = require("../utils/medicationCalculation");
const { generateReminderOccurrences } = require("../utils/reminderOccurrenceGenerator");
const refillCountRepository = require("../repositories/refillRepository");
const { calculateRemainingQuantity } = require("../utils/remainingQuantityCalculation");
const { normalizeMedicine } = require("./ai/helpers/medicineNormalize");

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

    // Find last generated occurrence
    const lastOccurrence =
      await medicationReminderOccurrenceRepository.findLastOccurrenceByReminderId(reminder.id);

    if (!lastOccurrence) {
      return updatedMedication;
    }

    // const startFromDate = lastOccurrence.actualMedicationTime;
    // startFromDate + 1;
    const startFromDate = new Date(lastOccurrence.actualMedicationTime);
    startFromDate.setUTCDate(startFromDate.getUTCDate() + 1);

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
      await refillCountRepository.add({
        userId: medication.userId,
        medicationId: medication.id,
        beforeRefillTotalQuantity: medication.totalQuantity,
        beforeRefillRemainingQuantity: currentRemainingQuantity,
        refillQuantity: quantity,
        afterRefillTotalQuantity: newTotalQuantity,
        afterRefillRemainingQuantity: newRemainingQuantity,
      });
    }

    return updatedMedication;
  }

  // Onboarding Helper: build normalized structure from raw OCR data
  buildFromDocument(docMeds = []) {
    return (docMeds || []).map((med, index) => {
      const { onboardingMed } = normalizeMedicine(med, index);
      return onboardingMed;
    });
  }

  // Onboarding Helper: get times and food frequency defaults
  applyDefaults(frequency) {
    const defaultSchedules = {
      ONCE: { Morning: "08:00:00" },
      TWICE: { Morning: "08:00:00", Night: "20:00:00" },
      THRICE: { Morning: "08:00:00", Noon: "14:00:00", Night: "20:00:00" },
      "Once Daily": { Morning: "08:00:00" },
      "Twice Daily": { Morning: "08:00:00", Night: "20:00:00" },
      "Three Times Daily": { Morning: "08:00:00", Noon: "14:00:00", Night: "20:00:00" },
    };

    const schedule = defaultSchedules[frequency] || { Morning: "08:00:00" };

    return {
      medicationSchedule: schedule,
      food_context: "AFTER_FOOD",
    };
  }

  // Onboarding Helper: validate payload
  async validate(payload) {
    return await validateSchema(medicationOnboardingSchema, payload);
  }

  _mapFrequencyToDb(frequency) {
    const map = {
      ONCE: "Once Daily",
      TWICE: "Twice Daily",
      THRICE: "Three Times Daily",
      "Once Daily": "Once Daily",
      "Twice Daily": "Twice Daily",
      "Three Times Daily": "Three Times Daily",
    };
    return map[frequency] || "Once Daily";
  }

  _getFrequencyCount(frequency) {
    const map = {
      ONCE: 1,
      TWICE: 2,
      THRICE: 3,
      "Once Daily": 1,
      "Twice Daily": 2,
      "Three Times Daily": 3,
    };
    return map[frequency] || 1;
  }

  // Onboarding Helper: map fields and save single medication
  async create(userId, payload) {
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const frequencyDb = this._mapFrequencyToDb(payload.frequency);
    const defaults = this.applyDefaults(payload.frequency);

    let value = undefined;
    let unit = undefined;

    if (payload.type === "TABLET" || payload.type === "CAPSULE") {
      value = payload.dose.count;
      unit = payload.type.toLowerCase();
    } else {
      value = payload.dose.value;
      unit = payload.dose.unit;
    }

    const dosePerIntake = Number.isInteger(value) ? value : null;
    const unitDb = unit.toUpperCase();

    const foodContext = payload.foodContext || defaults.food_context;
    const foodFrequency = foodContext === "BEFORE_FOOD" ? "BEFORE_FOOD" : "AFTER_FOOD";

    const frequencyCount = this._getFrequencyCount(payload.frequency);
    const dailyConsumption = Math.ceil(value) * frequencyCount;

    let timeSchedule;
    if (
      payload.medicationSchedule &&
      (payload.medicationSchedule.Morning ||
        payload.medicationSchedule.Noon ||
        payload.medicationSchedule.Night ||
        payload.medicationSchedule.Custom)
    ) {
      timeSchedule = {
        Morning: payload.medicationSchedule.Morning,
        Noon: payload.medicationSchedule.Noon,
        Night: payload.medicationSchedule.Night,
        Custom: payload.medicationSchedule.Custom,
      };
    } else {
      timeSchedule = defaults.medicationSchedule;
    }

    const medicationSchedule = {
      ...timeSchedule,
      dose: { value, unit },
      source: payload.source || "MANUAL",
      refillAlert: !!payload.refill_alert,
      foodContext: foodFrequency,
    };

    const mappedData = {
      userId,
      patientCode: patient.patientCode,
      medicationName: payload.name,
      medicationType: payload.type,
      prescribedBy: payload.prescribed_by || null,
      dosePerIntake,
      frequency: frequencyDb,
      medicationSchedule,
      foodFrequency,
      startDate: payload.startDate ? new Date(payload.startDate) : new Date(),
      endDate: null,
      ongoing: false,
      totalQuantity: payload.total_quantity !== undefined ? payload.total_quantity : 0,
      unit: unitDb,
      dailyConsumption,
      reminderBeforeMinutes: payload.reminderBeforeMinutes || 5,
      notes: payload.notes || null,
      clientMedId: payload.client_med_id,
      softDelete: false,
    };

    return await medicationRepository.insert(mappedData);
  }

  // Onboarding Helper: map, validate, and bulk save multiple medications in a transaction
  async bulkCreate(userId, payloadList = []) {
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const mappedList = payloadList.map((payload) => {
      const frequencyDb = this._mapFrequencyToDb(payload.frequency);
      const defaults = this.applyDefaults(payload.frequency);

      let value = undefined;
      let unit = undefined;

      if (payload.type === "TABLET" || payload.type === "CAPSULE") {
        value = payload.dose.count;
        unit = payload.type.toLowerCase();
      } else {
        value = payload.dose.value;
        unit = payload.dose.unit;
      }

      const dosePerIntake = Number.isInteger(value) ? value : null;
      const unitDb = unit.toUpperCase();

      const foodContext = payload.foodContext || defaults.food_context;
      const foodFrequency = foodContext === "BEFORE_FOOD" ? "BEFORE_FOOD" : "AFTER_FOOD";

      const frequencyCount = this._getFrequencyCount(payload.frequency);
      const dailyConsumption = Math.ceil(value) * frequencyCount;

      let timeSchedule;
      if (
        payload.medicationSchedule &&
        (payload.medicationSchedule.Morning ||
          payload.medicationSchedule.Noon ||
          payload.medicationSchedule.Night ||
          payload.medicationSchedule.Custom)
      ) {
        timeSchedule = {
          Morning: payload.medicationSchedule.Morning,
          Noon: payload.medicationSchedule.Noon,
          Night: payload.medicationSchedule.Night,
          Custom: payload.medicationSchedule.Custom,
        };
      } else {
        timeSchedule = defaults.medicationSchedule;
      }

      const medicationSchedule = {
        ...timeSchedule,
        dose: { value, unit },
        source: payload.source || "MANUAL",
        refillAlert: !!payload.refill_alert,
        foodContext: foodFrequency,
      };

      return {
        userId,
        patientCode: patient.patientCode,
        medicationName: payload.name,
        medicationType: payload.type,
        prescribedBy: payload.prescribed_by || null,
        dosePerIntake,
        frequency: frequencyDb,
        medicationSchedule,
        foodFrequency,
        startDate: payload.startDate ? new Date(payload.startDate) : new Date(),
        endDate: null,
        ongoing: true,
        totalQuantity: payload.total_quantity !== undefined ? payload.total_quantity : 0,
        unit: unitDb,
        dailyConsumption,
        reminderBeforeMinutes: payload.reminderBeforeMinutes || 5,
        notes: payload.notes || null,
        clientMedId: payload.client_med_id,
        softDelete: false,
      };
    });

    return await medicationRepository.bulkInsert(mappedList);
  }

  // CHECK DUPLICATE MEDICATION
  async checkDuplicateMedication(userId, payload) {
    const validData = await validateSchema(checkDuplicateMedicationSchema, payload);
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const activeMedications = await medicationRepository.findAll(userId);

    const incomingRaw = validData.medicationName;
    const incomingNorm = normalizeMedicationName(incomingRaw);

    const exactMatches = [];
    const similarMatches = [];

    for (const med of activeMedications) {
      const existingRaw = med.medicationName || "";
      const existingNorm = normalizeMedicationName(existingRaw);

      if (!existingNorm && !existingRaw) continue;

      if (
        incomingNorm === existingNorm ||
        incomingRaw.toLowerCase().trim() === existingRaw.toLowerCase().trim()
      ) {
        exactMatches.push(med);
      } else if (
        incomingNorm.length >= 3 &&
        existingNorm.length >= 3 &&
        (incomingNorm.includes(existingNorm) || existingNorm.includes(incomingNorm))
      ) {
        similarMatches.push(med);
      }
    }

    const hasDuplicate = exactMatches.length > 0 || similarMatches.length > 0;
    let conflictType = null;
    let matchedMedications = [];

    if (exactMatches.length > 0) {
      conflictType = "EXACT_DUPLICATE";
      matchedMedications = exactMatches;
    } else if (similarMatches.length > 0) {
      conflictType = "SIMILAR_NAME";
      matchedMedications = similarMatches;
    }

    const suggestedActions = hasDuplicate
      ? [
          {
            action: "REFILL_EXISTING",
            label: "Refill current active medication schedule",
          },
          {
            action: "UPDATE_SCHEDULE",
            label: "Update existing medication timings or dosage",
          },
          {
            action: "CREATE_NEW_ANYWAY",
            label: "Add as a new separate medication course",
          },
        ]
      : [];

    return {
      hasDuplicate,
      conflictType,
      matchedMedication: matchedMedications.length > 0 ? matchedMedications[0] : null,
      matchedMedications,
      suggestedActions,
    };
  }
}

function normalizeMedicationName(name) {
  if (!name || typeof name !== "string") return "";
  let clean = name.toLowerCase().trim();
  clean = clean.replace(
    /^(?:tab\.|tablet|tab|cap\.|capsule|caps|cap|syp\.|syrup|syp|inj\.|injection|inj|drops?|drop|spray|inhaler|inh\.|inh)\s+/i,
    "",
  );
  clean = clean.replace(/\b\d+(\.\d+)?\s*(mg|g|mcg|ml|iu|puffs?)?\b/gi, "");
  clean = clean
    .replace(/[^a-z0-9\s]/gi, "")
    .replace(/\s+/g, " ")
    .trim();
  return clean;
}

module.exports = new MedicationService();
