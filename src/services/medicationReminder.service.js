const { errorConstants } = require("../constants/errorConstants");
const { NotFoundException, InvalidRequestException } = require("../exceptions/appError");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const { completionClassification } = require("../enums/completionClassification");
const { db } = require("../configs/db");
const medicationRepository = require("../repositories/medicationRepository");
const medicationReminderRepository = require("../repositories/medicationReminderRepository");
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const medicationOccurrenceHistoryRepository = require("../repositories/medicationOccurrenceHistoryRepository");
const patientRepository = require("../repositories/patientRepository");
const { generateReminderOccurrences } = require("../utils/reminderOccurrenceGenerator");
const {
  validateSchema,
  createReminderSchema,
  updateOccurrenceSchema,
  listOccurrencesQuerySchema,
} = require("../validations");
class MedicationReminderService {
  // Helper: create a single medication reminder
  async _createSingleReminder(userId, medicationId) {
    // VALIDATE MEDICATION OWNERSHIP
    const medication = await this.validateMedicationOwnership(medicationId, userId);

    // CHECK EXISTING REMINDER (IDEMPOTENCY)
    const existingReminder = await medicationReminderRepository.findByMedicationId(medication.id);
    if (existingReminder) {
      return existingReminder;
    }

    // CREATE MAIN REMINDER
    const reminder = await medicationReminderRepository.create({
      patientId: userId,
      medicationId: medication.id,
      reminderBeforeMinutes: medication.reminderBeforeMinutes,
      dosePerIntake: medication.dosePerIntake,
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
      await medicationRepository.updateById(medication.id, {
        endDate: recalculatedEndDate,
      });
    }

    return reminder;
  }

  //create
  async createReminder(userId, data) {
    // VALIDATE REQUEST
    const validData = await validateSchema(createReminderSchema, data);

    if (Array.isArray(validData)) {
      const reminders = [];
      for (const item of validData) {
        const medId = typeof item === "string" ? item : item?.medicationId;
        if (medId) {
          const rem = await this._createSingleReminder(userId, medId);
          reminders.push(rem);
        }
      }
      return reminders;
    }

    return await this._createSingleReminder(userId, validData.medicationId);
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
    const patientRecord = await patientRepository.findById(userId);
    const timezone = patientRecord?.timezone || "Asia/Kolkata";
    return medicationReminderOccurrenceRepository.findTodayOccurrences(userId, timezone);
  }

  //filter
  async getOccurrences(userId, data) {
    const filters = await validateSchema(listOccurrencesQuerySchema, data);
    return medicationReminderOccurrenceRepository.getOccurrences(userId, filters);
  }
  // UPDATE OCCURRENCE
  async updateOccurrence(id, userId, data) {
    const validData = await validateSchema(updateOccurrenceSchema, data);

    return db.transaction(async (tx) => {
      const occurrence = await medicationReminderOccurrenceRepository.findById(id, tx, true);

      if (!occurrence || String(occurrence.patientId) !== String(userId)) {
        throw new NotFoundException(errorConstants.MEDICATION_OCCURRENCE_NOT_FOUND);
      }

      const targetStatus = validData.status || reminderOccurrenceStatus.COMPLETED;

      if (targetStatus === reminderOccurrenceStatus.PENDING) {
        throw new InvalidRequestException("Cannot transition occurrence back to PENDING");
      }

      // Terminal status check: CANCELLED cannot transition to other statuses
      if (occurrence.status === reminderOccurrenceStatus.CANCELLED) {
        if (targetStatus === reminderOccurrenceStatus.CANCELLED) {
          return occurrence;
        }
        throw new InvalidRequestException("Cannot transition a cancelled reminder occurrence");
      }

      // COMPLETED cannot be transitioned to SKIPPED or CANCELLED
      if (occurrence.status === reminderOccurrenceStatus.COMPLETED) {
        if (
          targetStatus === reminderOccurrenceStatus.SKIPPED ||
          targetStatus === reminderOccurrenceStatus.CANCELLED
        ) {
          throw new InvalidRequestException(
            "Cannot skip or cancel an already completed reminder occurrence",
          );
        }
      }

      // Handle SKIPPED
      if (targetStatus === reminderOccurrenceStatus.SKIPPED) {
        if (
          occurrence.status === reminderOccurrenceStatus.SKIPPED &&
          occurrence.skipReason === (validData.skipReason || validData.notes || "User Skipped")
        ) {
          return occurrence;
        }

        const skipPayload = {
          status: reminderOccurrenceStatus.SKIPPED,
          completionClassification: completionClassification.SKIPPED,
          skipReason: validData.skipReason || validData.notes || "User Skipped",
          isOverdue: false,
          delayMinutes: null,
          completedAt: null,
        };

        const updated = await medicationReminderOccurrenceRepository.update(id, skipPayload, tx);

        await medicationOccurrenceHistoryRepository.create(
          {
            occurrenceId: id,
            patientId: occurrence.patientId,
            fromStatus: occurrence.status,
            toStatus: reminderOccurrenceStatus.SKIPPED,
            completionClassification: completionClassification.SKIPPED,
            completedAt: null,
            delayMinutes: null,
            actionTimestamp: new Date(),
            actor: "PATIENT",
            notes: validData.notes || validData.skipReason || "Skipped by patient",
          },
          tx,
        );

        return updated;
      }

      // Handle CANCELLED
      if (targetStatus === reminderOccurrenceStatus.CANCELLED) {
        if (occurrence.status === reminderOccurrenceStatus.CANCELLED) {
          return occurrence;
        }

        const cancelPayload = {
          status: reminderOccurrenceStatus.CANCELLED,
          completionClassification: null,
          skipReason: null,
          delayMinutes: null,
          completedAt: null,
          isOverdue: false,
        };

        const updated = await medicationReminderOccurrenceRepository.update(id, cancelPayload, tx);

        await medicationOccurrenceHistoryRepository.create(
          {
            occurrenceId: id,
            patientId: occurrence.patientId,
            fromStatus: occurrence.status,
            toStatus: reminderOccurrenceStatus.CANCELLED,
            completionClassification: null,
            completedAt: null,
            delayMinutes: null,
            actionTimestamp: new Date(),
            actor: "PATIENT",
            notes: validData.notes || "Cancelled by patient",
          },
          tx,
        );

        return updated;
      }

      // Handle COMPLETED (default or explicit)
      // Resolve canonical completedAt timestamp (supporting backward-compatible takenAt alias)
      const rawCompletedAt = validData.completedAt || validData.takenAt;
      const now = new Date();
      let canonicalCompletedAt;

      if (rawCompletedAt) {
        const parsed = new Date(rawCompletedAt);
        if (isNaN(parsed.getTime())) {
          throw new InvalidRequestException("Invalid completedAt timestamp format");
        }
        // Disallow arbitrary future timestamps (>60s clock skew allowance)
        if (parsed.getTime() > now.getTime() + 60000) {
          throw new InvalidRequestException("completedAt timestamp cannot be in the future");
        }
        canonicalCompletedAt = parsed;
      } else {
        // Server-recorded completion time for standard clients sending { status: 'COMPLETED' }
        canonicalCompletedAt = now;
      }

      // Check for idempotent duplicate request
      if (
        occurrence.status === reminderOccurrenceStatus.COMPLETED &&
        (!rawCompletedAt ||
          (occurrence.completedAt &&
            new Date(occurrence.completedAt).getTime() === canonicalCompletedAt.getTime()))
      ) {
        return occurrence;
      }

      // Calculate delay in UTC minutes
      const scheduledTime = new Date(occurrence.actualMedicationTime);
      if (isNaN(scheduledTime.getTime())) {
        throw new InvalidRequestException("Occurrence actualMedicationTime is invalid");
      }

      const diffMs = canonicalCompletedAt.getTime() - scheduledTime.getTime();
      const delayMinutes = Math.round(diffMs / 60000);

      // Determine classification using configurable on-time grace period and 5-minute early action window
      const EARLY_ACTION_WINDOW_MINUTES = 5;
      const rawGrace = process.env.MEDICATION_ON_TIME_GRACE_MINUTES;
      const parsedGrace = rawGrace?.trim() ? Number(rawGrace) : NaN;
      const onTimeGrace = Number.isFinite(parsedGrace) && parsedGrace >= 0 ? parsedGrace : 30;

      // Reject premature normal completion attempts (> 5 minutes before scheduled dose)
      if (delayMinutes < -EARLY_ACTION_WINDOW_MINUTES) {
        throw new InvalidRequestException(
          "Medication completion is not allowed before the action window (available 5 minutes before scheduled time)",
        );
      }

      const classification =
        delayMinutes < -EARLY_ACTION_WINDOW_MINUTES
          ? completionClassification.EARLY
          : delayMinutes > onTimeGrace
            ? completionClassification.LATE
            : completionClassification.ON_TIME;

      const updatePayload = {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: canonicalCompletedAt,
        delayMinutes,
        completionClassification: classification,
        skipReason: null,
        isOverdue: false,
      };

      const updated = await medicationReminderOccurrenceRepository.update(id, updatePayload, tx);

      // Write immutable transition history
      await medicationOccurrenceHistoryRepository.create(
        {
          occurrenceId: id,
          patientId: occurrence.patientId,
          fromStatus: occurrence.status,
          toStatus: reminderOccurrenceStatus.COMPLETED,
          completionClassification: classification,
          completedAt: canonicalCompletedAt,
          delayMinutes,
          actionTimestamp: now,
          actor: "PATIENT",
          notes:
            validData.notes ||
            (classification === completionClassification.LATE
              ? `Completed late by ${delayMinutes} minutes`
              : classification === completionClassification.EARLY
                ? `Completed early by ${Math.abs(delayMinutes)} minutes`
                : "Completed on time"),
        },
        tx,
      );

      return updated;
    });
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
    let timezone = filters.timezone;
    if (!timezone) {
      const patientRecord = await patientRepository.findById(userId);
      timezone = patientRecord?.timezone || "Asia/Kolkata";
    }
    return medicationReminderOccurrenceRepository.getMedicationSummary(userId, {
      ...filters,
      timezone,
    });
  }
}

module.exports = new MedicationReminderService();
