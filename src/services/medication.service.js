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
  batchDeleteMedicationSchema,
  validateSchema,
} = require("../validations");
const { calculateMedicationValues } = require("../utils/medicationCalculation");
const { calculateRemainingQuantity } = require("../utils/remainingQuantityCalculation");
const { generateReminderOccurrences } = require("../utils/reminderOccurrenceGenerator");
const refillCountRepository = require("../repositories/refillRepository");
const {
  normalizeMedicine,
  normalizeCreateMedicationInput,
} = require("../helpers/medicineNormalize.helper");
const medicationReminderService = require("./medicationReminder.service");
const {
  SUGGESTED_ACTIONS,
  findMedicationDuplicates,
  mapOnboardingMedicationToDb,
  throwDuplicateConflict,
  mapFrequencyToDb,
  getFrequencyCount,
} = require("../helpers/medication.helper");

class MedicationService {
  // CREATE MEDICATION
  async createMedication(userId, payload, options = {}) {
    const normalizedInput = normalizeCreateMedicationInput(payload);
    const validData = await validateSchema(createMedicationSchema, normalizedInput);
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }
    const rawRes = validData.resolution || payload.action || payload.resolution || "KEEP_NEW";
    const res = String(rawRes).trim().toUpperCase().replace(/\s+/g, "_");

    // If Keep Existing or Remove New, strictly DO NOT CREATE in DB
    if (res === "KEEP_EXISTING" || res === "REMOVE_NEW") {
      const dupCheck = await this.checkDuplicateMedication(userId, validData);
      return (
        dupCheck.matchedMedication ||
        dupCheck.matchedMedications?.[0] || {
          keptExisting: true,
          medicationName: validData.medicationName,
        }
      );
    }

    if (!options.skipDuplicateCheck) {
      const targetId =
        validData.replaceMedicationId ||
        validData.targetMedicationId ||
        validData.duplicateInfo?.matchedMedication?.id ||
        validData.matchedMedicationId;

      if (res === "REPLACE" && targetId) {
        try {
          await this.deleteMedication(targetId, userId);
        } catch (delErr) {
          console.warn(
            `[MedicationService] Soft-delete warning for replaced med ${targetId}:`,
            delErr.message,
          );
        }
      } else {
        const dupCheck = await this.checkDuplicateMedication(userId, validData);
        if (dupCheck.hasDuplicate) {
          throwDuplicateConflict(dupCheck);
        }
      }
    }
    const {
      resolution: _resolution,
      replaceMedicationId: _replaceMedicationId,
      targetMedicationId: _targetMedicationId,
      matchedMedicationId: _matchedMedicationId,
      selected: _selected,
      clientMedId: _clientMedId,
      refillAlert: _refillAlert,
      ...medicationPayload
    } = validData;

    const { endDate, dailyConsumption, unit, startDate } =
      calculateMedicationValues(medicationPayload);
    const medication = await medicationRepository.create({
      userId,
      patientCode: patient.patientCode,
      ...medicationPayload,
      endDate,
      dailyConsumption,
      unit,
      startDate,
    });
    return medication;
  }
  // SAVE MEDICATION WITH REMINDER (SHARED ORCHESTRATOR HELPER)
  async saveMedicationWithReminder(userId, payload, options = {}) {
    const medication = await this.createMedication(userId, payload, options);
    let reminder = null;
    if (medication && medication.id) {
      try {
        reminder = await medicationReminderService.createReminder(userId, {
          medicationId: medication.id,
        });
      } catch (err) {
        console.error(
          `[MedicationService] Failed to create reminder for medication ${medication.id}:`,
          err.message,
        );
      }
    }
    return { medication, reminder };
  }

  // UPDATE MEDICATION
  async updateMedication(id, userId, payload, options = {}) {
    // Validate request payload
    const validData = await validateSchema(updateMedicationSchema, payload);

    // Check medication
    const existingMedication = await medicationRepository.findById(id);

    if (!existingMedication || String(existingMedication.userId) !== String(userId)) {
      throw new NotFoundException(errorConstants.MEDICATION_NOT_FOUND);
    }
    if (!options.skipDuplicateCheck && validData.medicationName) {
      const { resolution, replaceMedicationId } = validData;
      if (
        resolution === "REPLACE" &&
        replaceMedicationId &&
        String(replaceMedicationId) !== String(id)
      ) {
        try {
          await this.deleteMedication(replaceMedicationId, userId);
        } catch (delErr) {
          console.warn(
            `[MedicationService] Soft-delete warning for replaced med ${replaceMedicationId} on update:`,
            delErr.message,
          );
        }
      } else {
        const activeMedications = await medicationRepository.findAll(userId);
        const dupCheck = findMedicationDuplicates(activeMedications, validData.medicationName, id);
        if (dupCheck.hasDuplicate) {
          throwDuplicateConflict(dupCheck);
        }
      }
    }
    const {
      resolution: _resolution,
      replaceMedicationId: _replaceMedicationId,
      ...updatePayload
    } = validData;

    // Find reminder
    const reminder = await medicationReminderRepository.findByMedicationId(id);

    // Calculate remaining quantity BEFORE update
    let remainingQuantity = await calculateRemainingQuantity(
      existingMedication,
      medicationReminderOccurrenceRepository,
    );

    // If total quantity is updated, recalculate remaining quantity
    if (updatePayload.totalQuantity !== undefined) {
      const completedCount =
        await medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId(id);
      const consumedQuantity = completedCount * Number(existingMedication.dosePerIntake || 1);
      remainingQuantity = Math.max(0, Number(updatePayload.totalQuantity) - consumedQuantity);
    }

    // Merge existing medication with incoming updates
    const updatedPayload = {
      ...existingMedication,
      ...updatePayload,
    };

    // Use updated total quantity if provided
    const totalQuantity =
      updatePayload.totalQuantity !== undefined
        ? Number(updatePayload.totalQuantity)
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

  // GET MEDICATION LIST (PAGINATED ARRAY)
  async getMedicationList(userId, payload = {}) {
    const pageNumber = Math.max(1, Number(payload.page || payload.pageNumber || 1));
    const pageLimit = Math.max(1, Number(payload.limit || payload.pageLimit || 20));

    const records = await medicationRepository.findAll(userId);
    const safeRecords = Array.isArray(records) ? records : [];
    const totalRecords = safeRecords.length;
    const totalPages = Math.max(1, Math.ceil(totalRecords / pageLimit));
    const safePageNumber = Math.min(pageNumber, totalPages);
    const startIndex = (safePageNumber - 1) * pageLimit;
    const data = safeRecords.slice(startIndex, startIndex + pageLimit);

    return {
      data,
      page: {
        pageLimit,
        pageNumber: safePageNumber,
        totalPages,
        totalRecords,
        hasNextPage: safePageNumber < totalPages,
        hasPrevPage: safePageNumber > 1,
      },
    };
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

  // BATCH DELETE MEDICATIONS
  async batchDeleteMedications(userId, payload) {
    const { ids } = await validateSchema(batchDeleteMedicationSchema, payload);
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const deletedIds = [];
    const notFoundIds = [];

    for (const id of ids) {
      try {
        await this.deleteMedication(id, userId);
        deletedIds.push(id);
      } catch (err) {
        console.error(`[MedicationService] Error deleting medication ${id}:`, err.message);

        notFoundIds.push(id);
      }
    }

    return {
      deletedCount: deletedIds.length,
      deletedIds,
      notFoundIds,
      totalRequested: ids.length,
    };
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
    const dbFreq = this._mapFrequencyToDb(frequency);
    const defaultSchedules = {
      ONCE: { Morning: "08:00:00" },
      TWICE: { Morning: "08:00:00", Night: "20:00:00" },
      THRICE: { Morning: "08:00:00", Noon: "14:00:00", Night: "20:00:00" },
      "Once Daily": { Morning: "08:00:00" },
      "Twice Daily": { Morning: "08:00:00", Night: "20:00:00" },
      "Three Times Daily": { Morning: "08:00:00", Noon: "14:00:00", Night: "20:00:00" },
      "As Needed": { Morning: "08:00:00" },
    };

    const schedule = defaultSchedules[dbFreq] ||
      defaultSchedules[frequency] || { Morning: "08:00:00" };

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
    return mapFrequencyToDb(frequency);
  }

  _getFrequencyCount(frequency) {
    return getFrequencyCount(frequency);
  }

  // Onboarding Helper: map fields and save single medication
  async create(userId, payload) {
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const defaults = this.applyDefaults(payload.frequency);
    const mappedData = mapOnboardingMedicationToDb(payload, patient, userId, defaults, {
      ongoing: false,
    });

    return await medicationRepository.insert(mappedData);
  }

  // Canonical Helper: map, validate, and bulk save multiple medications supporting KEEP_NEW, KEEP_EXISTING, REPLACE, and EDIT
  async bulkCreate(userId, payload = [], options = {}) {
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const payloadList = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.medications)
        ? payload.medications
        : [];

    if (!payloadList.length) {
      return [];
    }

    // Check duplicate medications if not explicitly skipped
    if (!options.skipDuplicateCheck) {
      const duplicateChecks = await this.checkDuplicateMedicationsBatch(userId, payloadList);
      for (const item of duplicateChecks) {
        if (!item || !item.duplicateInfo?.hasDuplicate) continue;

        const rawRes = item.resolution || item.action || "";
        const res = String(rawRes).trim().toUpperCase().replace(/\s+/g, "_");
        if (
          item.selected === false ||
          res === "KEEP_EXISTING" ||
          res === "REMOVE_NEW" ||
          res === "REPLACE" ||
          res === "EDIT" ||
          res === "KEEP_NEW" ||
          res === "KEEP_BOTH"
        ) {
          continue;
        }

        throwDuplicateConflict(item.duplicateInfo);
      }
    }

    const created = [];
    const updated = [];
    const kept = [];

    for (const rawItem of payloadList) {
      if (!rawItem) continue;

      let medData =
        typeof rawItem === "object" && rawItem !== null
          ? { ...rawItem }
          : { id: rawItem, selected: true };

      const itemRes = String(medData.resolution || medData.action || "")
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "_");

      if (medData.selected === false || itemRes === "KEEP_EXISTING" || itemRes === "REMOVE_NEW") {
        kept.push(medData.duplicateInfo?.matchedMedication || medData);
        continue;
      }

      const normalized = normalizeCreateMedicationInput(medData);
      const res = String(
        normalized.resolution || medData.resolution || medData.action || "KEEP_NEW",
      )
        .trim()
        .toUpperCase()
        .replace(/\s+/g, "_");

      if (res === "KEEP_EXISTING" || res === "REMOVE_NEW") {
        kept.push(medData.duplicateInfo?.matchedMedication || medData);
        continue;
      }

      if (res === "REPLACE") {
        const targetId =
          normalized.replaceMedicationId ||
          medData.replaceMedicationId ||
          medData.targetMedicationId ||
          medData.duplicateInfo?.matchedMedication?.id ||
          medData.matchedMedicationId;

        if (targetId) {
          try {
            await this.deleteMedication(targetId, userId);
          } catch (delErr) {
            console.warn(
              `[MedicationService] Soft-delete warning for replaced med ${targetId}:`,
              delErr.message,
            );
          }
        }

        try {
          const med = await this.createMedication(userId, normalized, { skipDuplicateCheck: true });
          if (med && med.id) {
            created.push(med);
            try {
              await medicationReminderService.createReminder(userId, { medicationId: med.id });
            } catch (rErr) {
              console.warn(
                `[MedicationService] Error creating reminder for replaced med ${med.id}:`,
                rErr.message,
              );
            }
          }
        } catch (cErr) {
          console.error("[MedicationService] Error creating replaced medication:", cErr.message);
          if (!options.skipDuplicateCheck) {
            throw cErr;
          }
        }
        continue;
      }

      if (res === "EDIT") {
        const targetId =
          normalized.replaceMedicationId ||
          medData.replaceMedicationId ||
          medData.targetMedicationId ||
          medData.duplicateInfo?.matchedMedication?.id ||
          medData.matchedMedicationId;

        if (targetId) {
          try {
            const upd = await this.updateMedication(targetId, userId, normalized, {
              skipDuplicateCheck: true,
            });
            if (upd && upd.id) {
              updated.push(upd);
            }
          } catch (uErr) {
            console.warn(
              `[MedicationService] Error updating medication ${targetId}:`,
              uErr.message,
            );
            // Fallback to insert if target medication update fails
            try {
              const med = await this.createMedication(userId, normalized, {
                skipDuplicateCheck: true,
              });
              if (med && med.id) {
                created.push(med);
                try {
                  await medicationReminderService.createReminder(userId, { medicationId: med.id });
                } catch (rErr) {
                  console.warn(
                    `[MedicationService] Error creating reminder for fallback med ${med.id}:`,
                    rErr.message,
                  );
                }
              }
            } catch (fbErr) {
              console.error("[MedicationService] Fallback create failed:", fbErr.message);
              if (!options.skipDuplicateCheck) {
                throw fbErr;
              }
            }
          }
        } else {
          try {
            const med = await this.createMedication(userId, normalized, {
              skipDuplicateCheck: true,
            });
            if (med && med.id) {
              created.push(med);
              try {
                await medicationReminderService.createReminder(userId, { medicationId: med.id });
              } catch (rErr) {
                console.warn(
                  `[MedicationService] Error creating reminder for med ${med.id}:`,
                  rErr.message,
                );
              }
            }
          } catch (cErr) {
            console.error("[MedicationService] Error creating medication:", cErr.message);
            if (!options.skipDuplicateCheck) {
              throw cErr;
            }
          }
        }
        continue;
      }

      // Default: KEEP_NEW
      try {
        const med = await this.createMedication(userId, normalized, { skipDuplicateCheck: true });
        if (med && med.id) {
          created.push(med);
          try {
            await medicationReminderService.createReminder(userId, { medicationId: med.id });
          } catch (rErr) {
            console.warn(
              `[MedicationService] Error creating reminder for med ${med.id}:`,
              rErr.message,
            );
          }
        }
      } catch (cErr) {
        console.error(
          `[MedicationService] Error creating new medication for userId=${userId}: ${cErr.message}`,
        );
        if (!options.skipDuplicateCheck) {
          throw cErr;
        }
        // Idempotency check: if medication was already created in DB for this user, treat as kept/existing
        try {
          const dupCheck = await this.checkDuplicateMedication(userId, normalized);
          if (dupCheck.hasDuplicate && dupCheck.matchedMedication) {
            kept.push(dupCheck.matchedMedication);
          }
        } catch {
          // Ignore secondary lookup errors
        }
      }
    }

    const result = [...created];
    result.created = created;
    result.updated = updated;
    result.kept = kept;
    result.createdCount = created.length;
    result.updatedCount = updated.length;
    result.keptCount = kept.length;
    result.totalProcessed = payloadList.length;
    return result;
  }

  // CHECK DUPLICATE MEDICATION
  async checkDuplicateMedication(userId, payload) {
    const validData = await validateSchema(checkDuplicateMedicationSchema, payload);
    const patient = await patientRepository.findById(userId);
    if (!patient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const activeMedications = await medicationRepository.findAll(userId);
    return findMedicationDuplicates(activeMedications, validData?.medicationName);
  }

  // CHECK DUPLICATE MEDICATIONS BATCH
  async checkDuplicateMedicationsBatch(userId, medicineList = [], options = {}) {
    if (!Array.isArray(medicineList) || medicineList.length === 0) {
      return [];
    }

    let activeMedications = [];
    if (userId && !options.skipDbCheck && !options.inBatchOnly) {
      try {
        const meds = await medicationRepository.findAll(userId);
        activeMedications = Array.isArray(meds) ? meds : [];
      } catch (err) {
        console.warn(
          "[MedicationService] Active medications DB query failed in batch duplicate check:",
          err.message,
        );
        activeMedications = [];
      }
    }

    const results = medicineList.map((item, index) => {
      const incomingRaw =
        item.medicationName || item.name || item.medicine_name || item.medicineName || "";

      const exactMatches = [];
      const similarMatches = [];

      if (incomingRaw && typeof incomingRaw === "string" && incomingRaw.trim()) {
        // 1. Check against active DB medications using existing findMedicationDuplicates
        const dbDup = findMedicationDuplicates(
          activeMedications,
          incomingRaw,
          item.isSaved || item.dbId ? item.dbId || item.id : null,
        );
        if (dbDup.matchedMedications?.length) {
          if (dbDup.conflictType === "EXACT_DUPLICATE") {
            exactMatches.push(...dbDup.matchedMedications);
          } else {
            similarMatches.push(...dbDup.matchedMedications);
          }
        }

        // 2. Check against in-batch items (other extracted medicines in same request)
        medicineList.forEach((otherItem, otherIdx) => {
          if (otherIdx === index) return;
          if (item.isSaved || item.dbId) return;

          const itemKey = item.clientMedId || item.client_med_id || item.id;
          const otherKey = otherItem.clientMedId || otherItem.client_med_id || otherItem.id;
          if (itemKey && otherKey && itemKey === otherKey) return;

          if (
            item.documentId &&
            otherItem.documentId &&
            String(item.documentId) === String(otherItem.documentId)
          ) {
            return;
          }

          const otherRaw =
            otherItem.medicationName ||
            otherItem.name ||
            otherItem.medicine_name ||
            otherItem.medicineName ||
            "";
          if (!otherRaw) return;

          const inBatchDup = findMedicationDuplicates(
            [{ id: otherItem.id || otherItem.clientMedId, medicationName: otherRaw }],
            incomingRaw,
          );
          if (inBatchDup.hasDuplicate) {
            const clientMedId = otherItem.clientMedId || otherItem.client_med_id;
            const alreadyAdded = exactMatches
              .concat(similarMatches)
              .some(
                (m) =>
                  (clientMedId && m.client_med_id === clientMedId) || m.medicationName === otherRaw,
              );
            if (!alreadyAdded) {
              const matchedEntry = {
                medicationName: otherRaw,
                medicationType: otherItem.type || otherItem.medicationType || "TABLET",
                inBatch: true,
                index: otherIdx,
              };
              if (inBatchDup.conflictType === "EXACT_DUPLICATE") {
                exactMatches.push(matchedEntry);
              } else {
                similarMatches.push(matchedEntry);
              }
            }
          }
        });
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

      return {
        ...item,
        duplicateInfo: {
          hasDuplicate,
          conflictType,
          matchedMedication: matchedMedications.length > 0 ? matchedMedications[0] : null,
          matchedMedications,
          suggestedActions: hasDuplicate ? [...SUGGESTED_ACTIONS] : [],
        },
      };
    });

    return results;
  }
}

module.exports = new MedicationService();
