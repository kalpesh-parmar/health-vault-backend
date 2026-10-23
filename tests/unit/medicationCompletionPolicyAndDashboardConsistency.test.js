const medicationReminderService = require("../../src/services/medicationReminder.service");
const medicationAdherenceService = require("../../src/services/medicationAdherence.service");
const medicationReminderOccurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const _medicationOccurrenceHistoryRepository = require("../../src/repositories/medicationOccurrenceHistoryRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const patientRepository = require("../../src/repositories/patientRepository");
const _refillRepository = require("../../src/repositories/refillRepository");
const { completionClassification } = require("../../src/enums/completionClassification");
const { reminderOccurrenceStatus } = require("../../src/enums/reminderOccurrenceStatus");
const { InvalidRequestException } = require("../../src/exceptions/appError");

jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/medicationOccurrenceHistoryRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/refillRepository");
jest.mock("../../src/configs/db", () => ({
  db: {
    transaction: jest.fn(async (cb) => {
      const txMock = { _isTx: true };
      return cb(txMock);
    }),
  },
}));

describe("Medication Completion Policy, Reminder Locking & Dashboard Count Consistency", () => {
  const patientId = "patient-uuid-1001";
  const occurrenceId = "occ-test-uuid";
  const medicationId = "med-test-uuid";
  const scheduledTime = new Date("2026-10-22T08:30:00.000Z"); // 02:00 PM IST (08:30 UTC)

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // System time set to 12:00:00.000Z (05:30 PM IST) so test completion times (08:25 - 11:00) are valid past timestamps
    jest.setSystemTime(new Date("2026-10-22T12:00:00.000Z"));
    patientRepository.findById.mockResolvedValue({
      id: patientId,
      timezone: "Asia/Kolkata",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // 1. Five-Minute Early Action Window & Normal Completion Enforcement
  // =========================================================================
  describe("1. Five-Minute Early Action Window & Normal Completion Enforcement", () => {
    test("Attempting completion > 5 minutes early (e.g. 6m, 15m, 136m) is rejected with InvalidRequestException", async () => {
      const prematureTimes = [
        new Date("2026-10-22T08:24:00.000Z"), // -6m early
        new Date("2026-10-22T08:15:00.000Z"), // -15m early
        new Date("2026-10-22T06:14:00.000Z"), // -136m early (Paracetamol scenario)
      ];

      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        medicationId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);

      for (const prematureTime of prematureTimes) {
        await expect(
          medicationReminderService.updateOccurrence(occurrenceId, patientId, {
            status: reminderOccurrenceStatus.COMPLETED,
            completedAt: prematureTime.toISOString(),
          }),
        ).rejects.toThrow(InvalidRequestException);
      }
    });

    test("Completion at exactly -5 minutes early (boundary) is permitted and classified as ON_TIME", async () => {
      const boundaryTime = new Date("2026-10-22T08:25:00.000Z"); // -5m early
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        medicationId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const res = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: boundaryTime.toISOString(),
      });

      expect(res.status).toBe(reminderOccurrenceStatus.COMPLETED);
      expect(res.completionClassification).toBe(completionClassification.ON_TIME);
      expect(res.delayMinutes).toBe(-5);
      expect(res.completedAt).toEqual(boundaryTime);
    });

    test("Completion at -1 minute early (within window) is permitted and classified as ON_TIME", async () => {
      const withinWindow = new Date("2026-10-22T08:29:00.000Z"); // -1m early
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        medicationId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const res = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: withinWindow.toISOString(),
      });

      expect(res.completionClassification).toBe(completionClassification.ON_TIME);
      expect(res.delayMinutes).toBe(-1);
    });

    test("Completion at 0 minutes (exact scheduled time) is classified as ON_TIME", async () => {
      const exactTime = new Date("2026-10-22T08:30:00.000Z"); // 0m delay
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        medicationId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const res = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: exactTime.toISOString(),
      });

      expect(res.completionClassification).toBe(completionClassification.ON_TIME);
      expect(res.delayMinutes).toBe(0);
    });

    test("Completion at +15 minutes (within grace period) is classified as ON_TIME", async () => {
      const withinGrace = new Date("2026-10-22T08:45:00.000Z"); // +15m delay
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        medicationId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const res = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: withinGrace.toISOString(),
      });

      expect(res.completionClassification).toBe(completionClassification.ON_TIME);
      expect(res.delayMinutes).toBe(15);
    });

    test("Completion at +30 minutes (exact grace boundary) is classified as ON_TIME", async () => {
      const graceBoundary = new Date("2026-10-22T09:00:00.000Z"); // +30m delay
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        medicationId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const res = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: graceBoundary.toISOString(),
      });

      expect(res.completionClassification).toBe(completionClassification.ON_TIME);
      expect(res.delayMinutes).toBe(30);
    });

    test("Completion at +35 minutes (>30m grace) is classified as LATE", async () => {
      const lateTime = new Date("2026-10-22T09:05:00.000Z"); // +35m delay
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        medicationId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const res = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: lateTime.toISOString(),
      });

      expect(res.completionClassification).toBe(completionClassification.LATE);
      expect(res.delayMinutes).toBe(35);
    });

    test("Completion at +150 minutes (2.5 hours late) is classified as LATE", async () => {
      const veryLateTime = new Date("2026-10-22T11:00:00.000Z"); // +150m delay
      const existingOccurrence = {
        id: occurrenceId,
        patientId,
        medicationId,
        actualMedicationTime: scheduledTime,
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      };

      medicationReminderOccurrenceRepository.findById.mockResolvedValue(existingOccurrence);
      medicationReminderOccurrenceRepository.update.mockImplementation(async (id, payload) => ({
        ...existingOccurrence,
        ...payload,
      }));

      const res = await medicationReminderService.updateOccurrence(occurrenceId, patientId, {
        status: reminderOccurrenceStatus.COMPLETED,
        completedAt: veryLateTime.toISOString(),
      });

      expect(res.completionClassification).toBe(completionClassification.LATE);
      expect(res.delayMinutes).toBe(150);
    });
  });

  // =========================================================================
  // 2. Historical EARLY Classification Derivation & Timestamp Preservation
  // =========================================================================
  describe("2. Historical EARLY Classification Derivation & Timestamp Preservation", () => {
    test("Historical occurrence completed 136m early derives EARLY for display without rewriting record", async () => {
      const historicalCompletedAt = new Date("2026-10-22T06:14:00.000Z"); // 136m early
      medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails.mockResolvedValue([
        {
          occurrenceId: "occ-hist-paracetamol",
          medicationId: "med-paracetamol",
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          dosePerIntake: 1,
          unit: "TABLET",
          actualMedicationTime: scheduledTime,
          completedAt: historicalCompletedAt,
          delayMinutes: -136,
          completionClassification: "ON_TIME", // Legacy misclassification
          isOverdue: false,
          skipReason: null,
          status: "COMPLETED",
        },
      ]);

      const dailyDetails = await medicationAdherenceService.getDailyDetails(patientId, {
        date: "2026-10-22",
        timezone: "Asia/Kolkata",
      });

      expect(dailyDetails.doses.length).toBe(1);
      const dose = dailyDetails.doses[0];
      expect(dose.completionClassification).toBe("EARLY"); // Derived as EARLY
      expect(dose.completedAt).toEqual(historicalCompletedAt); // Preserved exactly
      expect(dose.delayMinutes).toBe(-136);
      expect(dose.delayFormatted).toBe("136m early");
    });

    test("Historical occurrence completed without completionClassification derives EARLY if delay < -5m", async () => {
      const historicalCompletedAt = new Date("2026-10-22T07:30:00.000Z"); // 60m early
      medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails.mockResolvedValue([
        {
          occurrenceId: "occ-hist-null-class",
          medicationId: "med-1",
          medicationName: "Domparidom",
          medicationType: "CAPSULE",
          dosePerIntake: 1,
          unit: "CAPSULE",
          actualMedicationTime: scheduledTime,
          completedAt: historicalCompletedAt,
          delayMinutes: null,
          completionClassification: null,
          isOverdue: false,
          skipReason: null,
          status: "COMPLETED",
        },
      ]);

      const dailyDetails = await medicationAdherenceService.getDailyDetails(patientId, {
        date: "2026-10-22",
        timezone: "Asia/Kolkata",
      });

      const dose = dailyDetails.doses[0];
      expect(dose.completionClassification).toBe("EARLY");
      expect(dose.retrospectivelyDerived).toBe(true);
      expect(dose.delayMinutes).toBe(-60);
      expect(dose.delayFormatted).toBe("60m early");
    });
  });

  // =========================================================================
  // 3. Read-Only Daily Medication Details Bottom Sheet
  // =========================================================================
  describe("3. Read-Only Daily Medication Details Bottom Sheet", () => {
    test("Daily Medication Details sheet sets actionable = false for both pending and completed doses", async () => {
      medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails.mockResolvedValue([
        {
          occurrenceId: "occ-1",
          medicationId: "med-1",
          medicationName: "Domparidom",
          actualMedicationTime: scheduledTime,
          completedAt: new Date("2026-10-22T08:25:00.000Z"),
          delayMinutes: -5,
          completionClassification: "ON_TIME",
          status: "COMPLETED",
          isOverdue: false,
        },
        {
          occurrenceId: "occ-2",
          medicationId: "med-2",
          medicationName: "Paracetamol",
          actualMedicationTime: scheduledTime,
          completedAt: null,
          delayMinutes: null,
          completionClassification: null,
          status: "PENDING",
          isOverdue: false,
        },
      ]);

      const dailyDetails = await medicationAdherenceService.getDailyDetails(patientId, {
        date: "2026-10-22",
        timezone: "Asia/Kolkata",
      });

      expect(dailyDetails.doses.length).toBe(2);
      expect(dailyDetails.doses[0].actionable).toBe(false);
      expect(dailyDetails.doses[1].actionable).toBe(false); // Today pending dose is strictly read-only
    });
  });

  // =========================================================================
  // 4. Weekly & Monthly Adherence Totals Conservation (EARLY + ON_TIME + LATE)
  // =========================================================================
  describe("4. Weekly & Monthly Adherence Totals Conservation", () => {
    test("Weekly adherence dailyBreakdown and KPI summary correctly count completedEarly", async () => {
      medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences.mockResolvedValue([
        {
          date: "2026-10-22",
          completedEarly: 1,
          completedOnTime: 2,
          completedLate: 1,
          completedUnknown: 0,
          overdue: 0,
          missed: 0,
          pending: 1,
          skipped: 0,
          total: 5,
        },
      ]);

      const weekly = await medicationAdherenceService.getWeeklyAdherence(patientId, {
        timezone: "Asia/Kolkata",
      });

      const today = weekly.dailyBreakdown.find((d) => d.date === "2026-10-22");
      expect(today.completedEarly).toBe(1);
      expect(today.completedOnTime).toBe(2);
      expect(today.completedLate).toBe(1);

      // KPI totalCompleted includes early + on_time + late
      expect(weekly.kpiSummary.completedEarly).toBe(1);
      expect(weekly.kpiSummary.completedOnTime).toBe(2);
      expect(weekly.kpiSummary.completedLate).toBe(1);
      expect(weekly.kpiSummary.totalCompleted).toBe(4); // 1 + 2 + 1
      expect(weekly.kpiSummary.adherencePercentage).toBe(100.0);
    });

    test("Monthly adherence metrics and percentages accurately include completedEarly and earlyAdherence", async () => {
      medicationReminderOccurrenceRepository.getMonthlyAdherenceOccurrences.mockResolvedValue({
        month: 10,
        year: 2026,
        total: 10,
        completedEarly: 2,
        completedOnTime: 5,
        completedLate: 1,
        completedUnknown: 0,
        overdue: 1,
        missed: 0,
        pending: 1,
        skipped: 0,
      });

      const monthly = await medicationAdherenceService.getMonthlyAdherence(patientId, {
        month: 10,
        year: 2026,
        timezone: "Asia/Kolkata",
      });

      expect(monthly.metrics.completedEarly).toBe(2);
      expect(monthly.metrics.completedOnTime).toBe(5);
      expect(monthly.metrics.completedLate).toBe(1);
      expect(monthly.metrics.totalCompleted).toBe(8); // 2 + 5 + 1
      expect(monthly.metrics.eligibleScheduledDoses).toBe(9); // 8 completed + 1 overdue

      // Check distinct percentages (not conflated)
      expect(monthly.percentages.earlyAdherence).toBe(22.2); // (2 / 9) * 100
      expect(monthly.percentages.onTimeAdherence).toBe(55.6); // (5 / 9) * 100
      expect(monthly.percentages.lateCompletion).toBe(11.1); // (1 / 9) * 100
      expect(monthly.percentages.overallAdherence).toBe(88.9); // (8 / 9) * 100
    });
  });

  // =========================================================================
  // 5. Dashboard Badge vs Reminders Screen Count Scoping & Refill Safety
  // =========================================================================
  describe("5. Dashboard Badge vs Reminders Screen Count Scoping & Refill Safety", () => {
    test("Dashboard summary with today date range returns today scheduled dose count (e.g. 2)", async () => {
      medicationReminderOccurrenceRepository.getMedicationSummary.mockResolvedValue({
        total: 2, // 2 scheduled doses today (Domparidom + Paracetamol)
        pending: 1,
        completed: 1,
        completedOnTime: 1,
        completedEarly: 0,
        completedLate: 0,
        overdue: 0,
        missed: 0,
        skipped: 0,
      });

      const summary = await medicationReminderService.getMedicationSummary(patientId, {
        startDate: "2026-10-22",
        endDate: "2026-10-22",
      });

      expect(summary.total).toBe(2);
      expect(medicationReminderOccurrenceRepository.getMedicationSummary).toHaveBeenCalledWith(
        patientId,
        expect.objectContaining({
          startDate: "2026-10-22",
          endDate: "2026-10-22",
        }),
      );
    });

    test("Reminders screen full range returns total pending across all dates (e.g. 19)", async () => {
      medicationReminderOccurrenceRepository.getMedicationSummary.mockResolvedValue({
        total: 21,
        totalOutstanding: 19,
        pending: 19, // All upcoming scheduled doses across the entire prescription horizon
        completed: 2,
        completedOnTime: 2,
        completedEarly: 0,
        completedLate: 0,
        overdue: 0,
        missed: 0,
        skipped: 0,
      });

      const summary = await medicationReminderService.getMedicationSummary(patientId, {});

      expect(summary.pending).toBe(19);
      expect(summary.completed).toBe(2);
      expect(summary.total).toBe(21);
      expect(summary.totalOutstanding).toBe(19);
    });

    test("Dashboard badge uses totalOutstanding = pending + overdue across all active medication schedules", async () => {
      medicationReminderOccurrenceRepository.getMedicationSummary.mockResolvedValue({
        total: 25,
        totalOutstanding: 21,
        pending: 18,
        overdue: 3,
        completed: 4,
        completedOnTime: 3,
        completedEarly: 1,
        completedLate: 0,
        missed: 0,
        skipped: 0,
      });

      const summary = await medicationReminderService.getMedicationSummary(patientId, {});

      expect(summary.totalOutstanding).toBe(21);
      expect(summary.pending).toBe(18);
      expect(summary.overdue).toBe(3);
      expect(summary.totalOutstanding).toBe(summary.pending + summary.overdue);
    });

    test("Completed occurrences deduct inventory via COUNT(DISTINCT) exactly once", async () => {
      // 1 tablet remaining tomorrow scenario
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: medicationId,
          medicationName: "TestMed",
          medicationType: "TABLET",
          totalQuantity: 10,
          dosePerIntake: 1,
          frequency: "ONCE_DAILY",
          dailyConsumption: 1,
          nextDose: "2026-10-23",
        },
      ]);

      // Exactly 9 completed occurrences recorded
      medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId.mockResolvedValue(
        9,
      );
      medicationReminderOccurrenceRepository.findUpcomingOccurrencesByMedicationId.mockResolvedValue(
        [
          {
            id: "upcoming-1",
            actualMedicationTime: new Date("2026-10-23T08:30:00.000Z"),
            status: "PENDING",
          },
        ],
      );

      const alerts = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(alerts.hasRefillAlerts).toBe(true);
      expect(alerts.medications.length).toBe(1);
      const medAlert = alerts.medications[0];
      expect(medAlert.remainingQuantity).toBe(1); // 10 - 9 = 1
      expect(medAlert.urgency).toBe("LOW_STOCK"); // <= 3 days supply
      expect(medAlert.daysRemaining).toBe(1);
    });
  });
});
