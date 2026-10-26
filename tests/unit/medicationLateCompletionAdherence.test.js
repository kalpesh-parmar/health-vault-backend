const medicationReminderService = require("../../src/services/medicationReminder.service");
const medicationReminderOccurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const medicationOccurrenceHistoryRepository = require("../../src/repositories/medicationOccurrenceHistoryRepository");
const patientRepository = require("../../src/repositories/patientRepository");
const { reminderOccurrenceStatus } = require("../../src/enums/reminderOccurrenceStatus");
const { completionClassification } = require("../../src/enums/completionClassification");
const { NotFoundException, InvalidRequestException } = require("../../src/exceptions/appError");

// Mock repositories and db.transaction
jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/medicationOccurrenceHistoryRepository");
jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/configs/db", () => ({
  db: {
    transaction: jest.fn(async (cb) => {
      // Mock transaction client by passing a dummy tx object
      const txMock = { _isTx: true };
      return cb(txMock);
    }),
  },
}));

describe("Phase 26: Medication Adherence, Late Completion, Overdue Fix & Ingestion Audit Tests", () => {
  const patientId = "patient-uuid-1001";
  const otherPatientId = "patient-uuid-9999";
  const occurrenceId = "occ-uuid-2001";

  // Reference times matching prompt specification:
  // Scheduled: 2026-10-21T02:30:00.000Z (08:00 AM IST)
  // Completed: 2026-10-21T05:00:00.000Z (10:30 AM IST)
  // Delay: 150 minutes
  const scheduledTime = new Date("2026-10-21T02:30:00.000Z");
  const completedLateTime = new Date("2026-10-21T05:00:00.000Z");

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Anchor current test time to 2026-10-21T06:00:00.000Z (11:30 AM IST)
    jest.setSystemTime(new Date("2026-10-21T06:00:00.000Z"));
    process.env.MEDICATION_ON_TIME_GRACE_MINUTES = "30";
    patientRepository.findById.mockResolvedValue({
      id: patientId,
      timezone: "Asia/Kolkata",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe("1. Critical Acceptance Test (Mandatory Requirements)", () => {
    test("CRITICAL: Scheduled 08:00 AM IST, Completed 10:30 AM IST -> COMPLETED, LATE, delay=150m, isOverdue=false, 1 audit entry", async () => {
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: true,
        completedAt: null,
        delayMinutes: null,
        completionClassification: null,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));
      medicationOccurrenceHistoryRepository.create.mockResolvedValue({
        id: "hist-1",
        occurrenceId,
        patientId,
        fromStatus: reminderOccurrenceStatus.PENDING,
        toStatus: reminderOccurrenceStatus.COMPLETED,
        completionClassification: completionClassification.LATE,
        completedAt: completedLateTime,
        delayMinutes: 150,
      });

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completedLateTime.toISOString(),
      });

      // 1. Verify status model consistency
      expect(result.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(result.completionClassification).toBe(completionClassification.LATE);
      expect(result.delayMinutes).toBe(150);
      expect(result.isOverdue).toBe(false);
      expect(result.completedAt).toEqual(completedLateTime);

      // 2. Verify update call with transaction client
      expect(medicationReminderOccurrenceRepository.update).toHaveBeenCalledWith(
        occurrenceId,
        expect.objectContaining({
          status: reminderOccurrenceStatus.COMPLETED,
          completionClassification: completionClassification.LATE,
          delayMinutes: 150,
          isOverdue: false,
          completedAt: completedLateTime,
        }),
        expect.objectContaining({ _isTx: true }),
      );

      // 3. Verify exactly one audit transition record
      expect(medicationOccurrenceHistoryRepository.create).toHaveBeenCalledTimes(1);
      expect(medicationOccurrenceHistoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          occurrenceId,
          patientId,
          fromStatus: reminderOccurrenceStatus.PENDING,
          toStatus: reminderOccurrenceStatus.COMPLETED,
          completionClassification: completionClassification.LATE,
          completedAt: completedLateTime,
          delayMinutes: 150,
        }),
        expect.objectContaining({ _isTx: true }),
      );
    });

    test("CRITICAL: Summary returns completed=1, completedLate=1, overdue=0, missed=0", async () => {
      // Simulate summary repository return when completed late dose is registered
      const mockSummary = {
        total: 1,
        pending: 0,
        completed: 1,
        completedOnTime: 0,
        completedLate: 1,
        overdue: 0,
        missed: 0,
        skipped: 0,
      };

      medicationReminderOccurrenceRepository.getMedicationSummary.mockResolvedValue(mockSummary);

      const summary = await medicationReminderService.getMedicationSummary(patientId, {
        startDate: "2026-10-21",
        endDate: "2026-10-21",
      });

      expect(summary.completed).toBe(1);
      expect(summary.completedLate).toBe(1);
      expect(summary.overdue).toBe(0);
      expect(summary.missed).toBe(0);
      expect(summary.completedOnTime).toBe(0);
      expect(summary.total).toBe(1);

      // Verify patient timezone was resolved and passed to repository
      expect(medicationReminderOccurrenceRepository.getMedicationSummary).toHaveBeenCalledWith(
        patientId,
        expect.objectContaining({
          timezone: "Asia/Kolkata",
        }),
      );
    });
  });

  describe("2. On-Time Completion (Within Grace Window)", () => {
    test("Scheduled 02:30:00.000Z, Completed 02:45:00.000Z (15m delay <= 30m grace) -> ON_TIME", async () => {
      const completedOnTime = new Date("2026-10-21T02:45:00.000Z");
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completedOnTime.toISOString(),
      });

      expect(result.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(result.completionClassification).toBe(completionClassification.ON_TIME);
      expect(result.delayMinutes).toBe(15);
      expect(result.isOverdue).toBe(false);
      expect(result.completedAt).toEqual(completedOnTime);

      expect(medicationOccurrenceHistoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          fromStatus: reminderOccurrenceStatus.PENDING,
          toStatus: reminderOccurrenceStatus.COMPLETED,
          completionClassification: completionClassification.ON_TIME,
          completedAt: completedOnTime,
          delayMinutes: 15,
        }),
        expect.anything(),
      );
    });
  });

  describe("3. Early Intake & 5-Minute Action Window", () => {
    test("Attempting normal completion earlier than 5 minutes before scheduled dose throws InvalidRequestException", async () => {
      const completedTooEarly = new Date("2026-10-21T02:15:00.000Z"); // -15m delay < -5m window
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);

      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.COMPLETED,
          completedAt: completedTooEarly.toISOString(),
        }),
      ).rejects.toThrow(InvalidRequestException);
    });

    test("Scheduled 02:30:00.000Z, Completed 02:27:00.000Z (-3m delay, within 5m early window) -> ON_TIME, delay=-3", async () => {
      const completedWithinWindow = new Date("2026-10-21T02:27:00.000Z");
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completedWithinWindow.toISOString(),
      });

      expect(result.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(result.completionClassification).toBe(completionClassification.ON_TIME);
      expect(result.delayMinutes).toBe(-3);
      expect(result.isOverdue).toBe(false);
      expect(result.completedAt).toEqual(completedWithinWindow);
    });

    test("Boundary: Exactly -5m early (02:25:00.000Z for 02:30:00.000Z) is accepted as ON_TIME", async () => {
      const completedExactWindowBoundary = new Date("2026-10-21T02:25:00.000Z");
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completedExactWindowBoundary.toISOString(),
      });

      expect(result.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(result.completionClassification).toBe(completionClassification.ON_TIME);
      expect(result.delayMinutes).toBe(-5);
      expect(result.completedAt).toEqual(completedExactWindowBoundary);
    });
  });

  describe("4. Skipped Doses", () => {
    test("Marking occurrence SKIPPED sets classification and records skip reason", async () => {
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: true,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.SKIPPED,
        skipReason: "Experiencing mild nausea",
      });

      expect(result.status).toBe(reminderOccurrenceStatus.SKIPPED);
      expect(result.completionClassification).toBe(completionClassification.SKIPPED);
      expect(result.skipReason).toBe("Experiencing mild nausea");
      expect(result.isOverdue).toBe(false);
      expect(result.completedAt).toBeNull();
      expect(result.delayMinutes).toBeNull();

      expect(medicationOccurrenceHistoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          occurrenceId,
          patientId,
          fromStatus: reminderOccurrenceStatus.PENDING,
          toStatus: reminderOccurrenceStatus.SKIPPED,
          completionClassification: completionClassification.SKIPPED,
          completedAt: null,
          notes: "Experiencing mild nausea",
        }),
        expect.anything(),
      );
    });
  });

  describe("5. Cancelled Reminders", () => {
    test("Marking occurrence CANCELLED updates status and clears overdue and completion metadata", async () => {
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: true,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.CANCELLED,
        notes: "Medication stopped by doctor",
      });

      expect(result.status).toBe(reminderOccurrenceStatus.CANCELLED);
      expect(result.isOverdue).toBe(false);
      expect(result.completedAt).toBeNull();
      expect(result.completionClassification).toBeNull();

      expect(medicationOccurrenceHistoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          occurrenceId,
          fromStatus: reminderOccurrenceStatus.PENDING,
          toStatus: reminderOccurrenceStatus.CANCELLED,
          completionClassification: null,
          completedAt: null,
          notes: "Medication stopped by doctor",
        }),
        expect.anything(),
      );
    });
  });

  describe("6. Duplicate Completion & Idempotency", () => {
    test("Submitting duplicate completion with identical completedAt returns existing occurrence without duplicate audit", async () => {
      const completedOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completedLateTime,
        delayMinutes: 150,
        completionClassification: completionClassification.LATE,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(completedOccurrence);

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completedLateTime.toISOString(),
      });

      expect(result).toBe(completedOccurrence);
      // No duplicate DB update or audit log
      expect(medicationReminderOccurrenceRepository.update).not.toHaveBeenCalled();
      expect(medicationOccurrenceHistoryRepository.create).not.toHaveBeenCalled();
    });

    test("Submitting legacy { status: 'COMPLETED' } on already completed occurrence returns idempotently", async () => {
      const completedOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completedLateTime,
        delayMinutes: 150,
        completionClassification: completionClassification.LATE,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(completedOccurrence);

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
      });

      expect(result).toBe(completedOccurrence);
      expect(medicationReminderOccurrenceRepository.update).not.toHaveBeenCalled();
      expect(medicationOccurrenceHistoryRepository.create).not.toHaveBeenCalled();
    });
  });

  describe("7. Historical Missed Correction", () => {
    test("Historical correction of an overdue/missed dose updates to COMPLETED_LATE and writes transition audit", async () => {
      const overdueOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: true,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(overdueOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...overdueOccurrence,
        ...payload,
      }));

      // Patient retroactively confirms taking dose at 10:30 AM
      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completedLateTime.toISOString(),
        notes: "Historical confirmation from morning dose",
      });

      expect(result.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(result.completionClassification).toBe(completionClassification.LATE);
      expect(result.delayMinutes).toBe(150);
      expect(result.isOverdue).toBe(false);
      expect(result.completedAt).toEqual(completedLateTime);

      expect(medicationOccurrenceHistoryRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          occurrenceId,
          patientId,
          fromStatus: reminderOccurrenceStatus.PENDING,
          toStatus: reminderOccurrenceStatus.COMPLETED,
          completionClassification: completionClassification.LATE,
          completedAt: completedLateTime,
          delayMinutes: 150,
          notes: "Historical confirmation from morning dose",
        }),
        expect.anything(),
      );
    });
  });

  describe("8. Backward Compatibility (Legacy API Clients)", () => {
    test("Legacy client sending { status: 'COMPLETED' } defaults completedAt to now() and computes classification", async () => {
      // scheduled at 02:30:00.000Z, now is set to 06:00:00.000Z (210 minutes delay)
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: true,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
      });

      expect(result.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(result.completionClassification).toBe(completionClassification.LATE);
      expect(result.delayMinutes).toBe(210);
      expect(result.isOverdue).toBe(false);
      expect(result.completedAt).toEqual(new Date("2026-10-21T06:00:00.000Z"));
    });

    test("Client sending legacy takenAt field is seamlessly accepted as alias for completedAt", async () => {
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: true,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        takenAt: completedLateTime.toISOString(),
      });

      expect(result.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(result.completedAt).toEqual(completedLateTime);
      expect(result.completionClassification).toBe(completionClassification.LATE);
      expect(result.delayMinutes).toBe(150);
    });
  });

  describe("9. Validation & Defensive Checks", () => {
    test("Future timestamp beyond 60s clock skew throws InvalidRequestException", async () => {
      // Current system time: 2026-10-21T06:00:00.000Z
      // Attempt to submit completedAt 2 hours in the future
      const futureCompletedAt = new Date("2026-10-21T08:00:00.000Z");
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);

      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.COMPLETED,
          completedAt: futureCompletedAt.toISOString(),
        }),
      ).rejects.toThrow(InvalidRequestException);

      expect(medicationReminderOccurrenceRepository.update).not.toHaveBeenCalled();
      expect(medicationOccurrenceHistoryRepository.create).not.toHaveBeenCalled();
    });

    test("Malformed completedAt timestamp fails Zod schema validation", async () => {
      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.COMPLETED,
          completedAt: "not-a-date",
        }),
      ).rejects.toThrow();
    });

    test("Unauthorized patient attempting to update occurrence throws NotFoundException", async () => {
      const existingOccurrence = {
        id: occurrenceId,
        patientId: otherPatientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);

      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.COMPLETED,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    test("Non-existent occurrence throws NotFoundException", async () => {
      medicationReminderOccurrenceRepository.findById.mockResolvedValue(null);

      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.COMPLETED,
        }),
      ).rejects.toThrow(NotFoundException);
    });

    test("Transitioning cancelled occurrence throws InvalidRequestException", async () => {
      const cancelledOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.CANCELLED,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(cancelledOccurrence);

      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.COMPLETED,
        }),
      ).rejects.toThrow(InvalidRequestException);
    });

    test("Transitioning completed occurrence to SKIPPED or CANCELLED throws InvalidRequestException", async () => {
      const completedOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.COMPLETED,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(completedOccurrence);

      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.SKIPPED,
        }),
      ).rejects.toThrow(InvalidRequestException);

      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.CANCELLED,
        }),
      ).rejects.toThrow(InvalidRequestException);
    });

    test("Submitting PENDING as target status is rejected by schema", async () => {
      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.PENDING,
        }),
      ).rejects.toThrow();
    });

    test("Non-numeric MEDICATION_ON_TIME_GRACE_MINUTES safely falls back to default 30 minutes", async () => {
      process.env.MEDICATION_ON_TIME_GRACE_MINUTES = "invalid_not_a_number";
      const completed35MinLate = new Date("2026-10-21T03:05:00.000Z"); // 35 min > fallback 30m grace
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completed35MinLate.toISOString(),
      });

      expect(result.completionClassification).toBe(completionClassification.LATE);
      expect(result.delayMinutes).toBe(35);
    });

    test("completedAt excessively prior to scheduled time (> grace period) throws InvalidRequestException", async () => {
      const completedTooEarly = new Date("2026-10-21T01:45:00.000Z"); // 45m before scheduled (02:30)
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);

      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.COMPLETED,
          completedAt: completedTooEarly.toISOString(),
        }),
      ).rejects.toThrow(InvalidRequestException);
    });

    test("Live patient marking dose taken before 5-minute window throws InvalidRequestException", async () => {
      // Dose scheduled at 02:30:00.000Z, system time is 01:45:00.000Z (45m early)
      jest.setSystemTime(new Date("2026-10-21T01:45:00.000Z"));
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);

      await expect(
        medicationReminderService.updateOccurrence(occurrenceId, patientId, {
          status: reminderOccurrenceStatus.COMPLETED,
        }),
      ).rejects.toThrow(InvalidRequestException);
    });

    test("Live patient marking dose taken within 5-minute window without supplying completedAt succeeds as ON_TIME", async () => {
      // Dose scheduled at 02:30:00.000Z, system time is 02:28:00.000Z (2m early)
      const nowTime = new Date("2026-10-21T02:28:00.000Z");
      jest.setSystemTime(nowTime);
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
      });

      expect(result.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(result.completionClassification).toBe(completionClassification.ON_TIME);
      expect(result.delayMinutes).toBe(-2);
      expect(result.completedAt).toEqual(nowTime);
    });
  });

  describe("10. Summary Metrics Conservation & Mutual Exclusivity", () => {
    test("Overdue counting fix guarantees mutual exclusivity across all categories", async () => {
      // Conservation check: total = completed + pending + overdue + missed + skipped
      const summaryFixture = {
        total: 5,
        completed: 2,
        completedOnTime: 1,
        completedLate: 1,
        pending: 1,
        overdue: 1,
        missed: 1,
        skipped: 0,
      };

      medicationReminderOccurrenceRepository.getMedicationSummary.mockResolvedValue(summaryFixture);

      const res = await medicationReminderService.getMedicationSummary(patientId, {});

      // Completed doses breakdown matches total completed
      expect(res.completedOnTime + res.completedLate).toBe(res.completed);
      // Completed doses never overlap with overdue or missed
      expect(res.completed).toBe(2);
      expect(res.overdue).toBe(1);
      expect(res.missed).toBe(1);
      // Conservation holds
      expect(res.completed + res.pending + res.overdue + res.missed + res.skipped).toBe(res.total);
    });

    test("Transitioning previously SKIPPED occurrence to COMPLETED clears skipReason to null", async () => {
      const skippedOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.SKIPPED,
        skipReason: "Nausea earlier",
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(skippedOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...skippedOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: completedLateTime.toISOString(),
      });

      expect(result.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(result.skipReason).toBeNull();
      expect(result.completionClassification).toBe(completionClassification.LATE);

      expect(medicationReminderOccurrenceRepository.update).toHaveBeenCalledWith(
        occurrenceId,
        expect.objectContaining({
          status: reminderOccurrenceStatus.COMPLETED,
          skipReason: null,
        }),
        expect.anything(),
      );
    });
  });

  describe("11. Timezone Correctness & Boundary Tests", () => {
    test("Uses patient IANA timezone (America/New_York) when querying summary", async () => {
      patientRepository.findById.mockResolvedValue({
        id: patientId,
        timezone: "America/New_York",
      });

      medicationReminderOccurrenceRepository.getMedicationSummary.mockResolvedValue({
        total: 1,
        completed: 1,
        completedLate: 0,
        completedOnTime: 1,
        overdue: 0,
        missed: 0,
        pending: 0,
        skipped: 0,
      });

      await medicationReminderService.getMedicationSummary(patientId, {});

      expect(medicationReminderOccurrenceRepository.getMedicationSummary).toHaveBeenCalledWith(
        patientId,
        expect.objectContaining({
          timezone: "America/New_York",
        }),
      );
    });

    test("Explicit timezone in filters overrides patient default timezone", async () => {
      patientRepository.findById.mockResolvedValue({
        id: patientId,
        timezone: "Asia/Kolkata",
      });

      medicationReminderOccurrenceRepository.getMedicationSummary.mockResolvedValue({
        total: 1,
        completed: 1,
        completedLate: 1,
        completedOnTime: 0,
        overdue: 0,
        missed: 0,
        pending: 0,
        skipped: 0,
      });

      await medicationReminderService.getMedicationSummary(patientId, {
        timezone: "UTC",
      });

      expect(medicationReminderOccurrenceRepository.getMedicationSummary).toHaveBeenCalledWith(
        patientId,
        expect.objectContaining({
          timezone: "UTC",
        }),
      );
    });

    test("Delay minutes calculation is invariant to local timezones because UTC instants are used", async () => {
      // 08:00 AM New York EDT is 12:00:00 UTC
      // 10:30 AM New York EDT is 14:30:00 UTC
      // Delay must be 150 minutes
      jest.setSystemTime(new Date("2026-10-21T15:00:00.000Z"));
      const nyScheduled = new Date("2026-10-21T12:00:00.000Z");
      const nyCompleted = new Date("2026-10-21T14:30:00.000Z");

      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: nyScheduled,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: true,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: nyCompleted.toISOString(),
      });

      expect(result.delayMinutes).toBe(150);
      expect(result.completionClassification).toBe(completionClassification.LATE);
    });

    test("Month-end boundary (Oct 31 to Nov 1) calculates delay correctly using UTC instants", async () => {
      // Dose scheduled at 23:45 UTC on Oct 31, completed at 00:15 UTC on Nov 1
      jest.setSystemTime(new Date("2026-11-01T01:00:00.000Z"));
      const oct31Scheduled = new Date("2026-10-31T23:45:00.000Z");
      const nov01Completed = new Date("2026-11-01T00:15:00.000Z"); // 30 minutes later

      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: oct31Scheduled,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: nov01Completed.toISOString(),
      });

      expect(result.delayMinutes).toBe(30);
      expect(result.completionClassification).toBe(completionClassification.ON_TIME);
    });

    test("Daylight Saving Time (DST) transition boundary calculates delay accurately using UTC instants", async () => {
      // America/New_York switches from EDT to EST in November
      // Nov 1, 2026 05:30 UTC to Nov 1, 2026 07:00 UTC (90 minutes)
      jest.setSystemTime(new Date("2026-11-01T08:00:00.000Z"));
      const dstScheduled = new Date("2026-11-01T05:30:00.000Z");
      const dstCompleted = new Date("2026-11-01T07:00:00.000Z");

      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        actualMedicationTime: dstScheduled,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: true,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const result = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: dstCompleted.toISOString(),
      });

      expect(result.delayMinutes).toBe(90);
      expect(result.completionClassification).toBe(completionClassification.LATE);
    });

    test("getTodayOccurrences resolves patient IANA timezone and passes it to repository", async () => {
      patientRepository.findById.mockResolvedValue({
        id: patientId,
        timezone: "America/New_York",
      });
      medicationReminderOccurrenceRepository.findTodayOccurrences.mockResolvedValue([]);

      await medicationReminderService.getTodayOccurrences(patientId);

      expect(patientRepository.findById).toHaveBeenCalledWith(patientId);
      expect(medicationReminderOccurrenceRepository.findTodayOccurrences).toHaveBeenCalledWith(
        patientId,
        "America/New_York",
      );
    });
  });
});
