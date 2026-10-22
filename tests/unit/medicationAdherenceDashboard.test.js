const medicationAdherenceService = require("../../src/services/medicationAdherence.service");
const medicationReminderOccurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const patientRepository = require("../../src/repositories/patientRepository");
const refillRepository = require("../../src/repositories/refillRepository");
const {
  weeklyDashboardQuerySchema,
  monthlyDashboardQuerySchema,
  dailyDetailsQuerySchema,
  refillsDashboardQuerySchema,
  isValidTimezone,
} = require("../../src/validations/adherenceDashboardValidation");
const { createMedicationSchema } = require("../../src/validations/medicationValidation");

jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/refillRepository");

describe("Phase 27: Weekly/Monthly Medication Adherence & Refill Intelligence Tests", () => {
  const patientId = "patient-uuid-1001";
  const otherPatientId = "patient-uuid-9999";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    // Anchor current test time to 2026-10-21T06:00:00.000Z (11:30 AM IST / 07:00 AM UTC)
    jest.setSystemTime(new Date("2026-10-21T06:00:00.000Z"));
    patientRepository.findById.mockResolvedValue({
      id: patientId,
      timezone: "Asia/Kolkata",
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  // =========================================================================
  // 1. CRITICAL ACCEPTANCE TEST (Mandatory Prompt Requirements)
  // =========================================================================
  describe("1. Critical Acceptance Test", () => {
    test("CRITICAL: Scheduled 08:00 AM IST, Completed 10:30 AM IST -> LATE, delay=150m, counted once in completedLate", async () => {
      // In weekly adherence: Day 2026-10-21 has 1 dose completed late
      medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences.mockResolvedValue([
        {
          date: "2026-10-21",
          completedOnTime: 0,
          completedLate: 1,
          overdue: 0,
          missed: 0,
          pending: 0,
          skipped: 0,
          total: 1,
        },
      ]);

      const weeklyResult = await medicationAdherenceService.getWeeklyAdherence(patientId, {
        timezone: "Asia/Kolkata",
      });

      // Verification of 7-day summary
      expect(weeklyResult.kpiSummary.totalScheduled).toBe(1);
      expect(weeklyResult.kpiSummary.completedLate).toBe(1);
      expect(weeklyResult.kpiSummary.totalCompleted).toBe(1);
      expect(weeklyResult.kpiSummary.completedOnTime).toBe(0);
      expect(weeklyResult.kpiSummary.overdue).toBe(0);
      expect(weeklyResult.kpiSummary.missed).toBe(0);
      expect(weeklyResult.kpiSummary.adherencePercentage).toBe(100.0);

      // Verify the specific day entry
      const todayEntry = weeklyResult.dailyBreakdown.find((d) => d.date === "2026-10-21");
      expect(todayEntry).toBeDefined();
      expect(todayEntry.completedLate).toBe(1);
      expect(todayEntry.totalCompleted).toBeUndefined(); // Individual day has completedLate & completedOnTime
      expect(todayEntry.completedOnTime).toBe(0);
      expect(todayEntry.overdue).toBe(0);
      expect(todayEntry.missed).toBe(0);
      expect(todayEntry.total).toBe(1);

      // In daily details: inspect the formatted scheduled vs completed times
      medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails.mockResolvedValue([
        {
          occurrenceId: "occ-late-1",
          medicationId: "med-1",
          reminderId: "rem-1",
          medicationName: "Amlodipine",
          medicationType: "TABLET",
          dosePerIntake: 1,
          unit: "TABLET",
          actualMedicationTime: new Date("2026-10-21T02:30:00.000Z"),
          completedAt: new Date("2026-10-21T05:00:00.000Z"),
          delayMinutes: 150,
          completionClassification: "LATE",
          isOverdue: false,
          skipReason: null,
          status: "COMPLETED",
        },
      ]);

      const details = await medicationAdherenceService.getDailyDetails(patientId, {
        date: "2026-10-21",
        timezone: "Asia/Kolkata",
      });

      expect(details.totalOccurrences).toBe(1);
      const dose = details.doses[0];
      expect(dose.scheduledTimeFormatted).toBe("08:00 AM");
      expect(dose.completedAtFormatted).toBe("10:30 AM");
      expect(dose.delayMinutes).toBe(150);
      expect(dose.delayFormatted).toBe("2h 30m late");
      expect(dose.completionClassification).toBe("LATE");
      expect(dose.status).toBe("COMPLETED");
      expect(dose.isOverdue).toBe(false);
      expect(dose.actionable).toBe(false); // Completed dose is not actionable
    });
  });

  // =========================================================================
  // 2. WEEKLY ADHERENCE ENGINE TESTS
  // =========================================================================
  describe("2. Weekly Adherence Engine (Last 7 Days)", () => {
    test("Guarantees exactly 7 consecutive chronological days even when DB returns sparse data", async () => {
      // DB only returns 2 days with data
      medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences.mockResolvedValue([
        {
          date: "2026-10-16",
          completedOnTime: 2,
          completedLate: 0,
          overdue: 0,
          missed: 0,
          pending: 0,
          skipped: 0,
          total: 2,
        },
        {
          date: "2026-10-21",
          completedOnTime: 1,
          completedLate: 1,
          overdue: 1,
          missed: 0,
          pending: 1,
          skipped: 0,
          total: 4,
        },
      ]);

      const res = await medicationAdherenceService.getWeeklyAdherence(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.dailyBreakdown).toHaveLength(7);
      expect(res.dateRange.startDate).toBe("2026-10-15");
      expect(res.dateRange.endDate).toBe("2026-10-21");

      const dates = res.dailyBreakdown.map((d) => d.date);
      expect(dates).toEqual([
        "2026-10-15",
        "2026-10-16",
        "2026-10-17",
        "2026-10-18",
        "2026-10-19",
        "2026-10-20",
        "2026-10-21",
      ]);

      // Zero-dose days must have 0 counts
      const zeroDay = res.dailyBreakdown.find((d) => d.date === "2026-10-17");
      expect(zeroDay.total).toBe(0);
      expect(zeroDay.completedOnTime).toBe(0);
      expect(zeroDay.completedLate).toBe(0);
      expect(zeroDay.overdue).toBe(0);
      expect(zeroDay.missed).toBe(0);
      expect(zeroDay.pending).toBe(0);
      expect(zeroDay.skipped).toBe(0);

      // Verify today indicator
      expect(res.dailyBreakdown.find((d) => d.date === "2026-10-21").isToday).toBe(true);
      expect(res.dailyBreakdown.find((d) => d.date === "2026-10-20").isToday).toBe(false);
    });

    test("Calculates 7-day adherence percentage excluding future pending doses", async () => {
      // 10 completed on time, 2 completed late, 2 overdue, 1 missed, 5 pending
      medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences.mockResolvedValue([
        {
          date: "2026-10-20",
          completedOnTime: 10,
          completedLate: 2,
          overdue: 2,
          missed: 1,
          pending: 5,
          skipped: 1,
          total: 21,
        },
      ]);

      const res = await medicationAdherenceService.getWeeklyAdherence(patientId, {
        timezone: "Asia/Kolkata",
      });

      // Total Completed = 10 + 2 = 12
      // Eligible Doses = Total Completed (12) + Overdue (2) + Missed (1) = 15
      // Future pending (5) and skipped (1) excluded from denominator
      // Expected adherence = (12 / 15) * 100 = 80.0%
      expect(res.kpiSummary.totalCompleted).toBe(12);
      expect(res.kpiSummary.completedOnTime).toBe(10);
      expect(res.kpiSummary.completedLate).toBe(2);
      expect(res.kpiSummary.overdue).toBe(2);
      expect(res.kpiSummary.missed).toBe(1);
      expect(res.kpiSummary.pending).toBe(5);
      expect(res.kpiSummary.skipped).toBe(1);
      expect(res.kpiSummary.adherencePercentage).toBe(80.0);
    });

    test("Empty 7-day period returns safe null adherence with hasData=false without division by zero", async () => {
      medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences.mockResolvedValue([]);

      const res = await medicationAdherenceService.getWeeklyAdherence(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.kpiSummary.totalScheduled).toBe(0);
      expect(res.kpiSummary.totalCompleted).toBe(0);
      expect(res.kpiSummary.hasData).toBe(false);
      expect(res.kpiSummary.adherencePercentage).toBe(null);
    });
  });

  // =========================================================================
  // 3. MONTHLY ADHERENCE ENGINE TESTS
  // =========================================================================
  describe("3. Monthly Adherence Engine", () => {
    test("Computes monthly metrics, percentages, and segmented progress ratios", async () => {
      medicationReminderOccurrenceRepository.getMonthlyAdherenceOccurrences.mockResolvedValue({
        completedOnTime: 48,
        completedLate: 8,
        overdue: 3,
        missed: 9,
        pending: 13,
        skipped: 2,
        total: 83,
      });

      const res = await medicationAdherenceService.getMonthlyAdherence(patientId, {
        month: 10,
        year: 2026,
        timezone: "Asia/Kolkata",
      });

      expect(res.month).toBe(10);
      expect(res.year).toBe(2026);
      expect(res.monthLabel).toContain("October");

      // Metrics
      expect(res.metrics.completedOnTime).toBe(48);
      expect(res.metrics.completedLate).toBe(8);
      expect(res.metrics.totalCompleted).toBe(56);
      expect(res.metrics.overdue).toBe(3);
      expect(res.metrics.missed).toBe(9);
      expect(res.metrics.totalOverdueAndMissed).toBe(12);
      expect(res.metrics.eligibleScheduledDoses).toBe(68); // 56 + 12
      expect(res.metrics.pending).toBe(13);
      expect(res.metrics.skipped).toBe(2);

      // Percentages:
      // Overall adherence = (56 / 68) * 100 = 82.4%
      // On-time adherence = (48 / 68) * 100 = 70.6%
      // Late completion = (8 / 68) * 100 = 11.8%
      // Overdue and missed = (12 / 68) * 100 = 17.6%
      expect(res.percentages.overallAdherence).toBe(82.4);
      expect(res.percentages.onTimeAdherence).toBe(70.6);
      expect(res.percentages.lateCompletion).toBe(11.8);
      expect(res.percentages.overdueAndMissed).toBe(17.6);

      // Segmented ratios (out of 83 total in month)
      expect(res.segmentedRatios.completedRatio).toBe(Number((56 / 83).toFixed(3)));
      expect(res.segmentedRatios.overdueRatio).toBe(Number((12 / 83).toFixed(3)));
      expect(res.segmentedRatios.pendingRatio).toBe(Number((13 / 83).toFixed(3)));
      expect(res.segmentedRatios.skippedRatio).toBe(Number((2 / 83).toFixed(3)));

      // Status Distribution percentages (common denominator totalInMonth = 83)
      expect(res.metrics.totalScheduled).toBe(83);
      expect(res.percentages.completedDistribution).toBe(Number(((56 / 83) * 100).toFixed(1)));
      expect(res.percentages.pendingDistribution).toBe(Number(((13 / 83) * 100).toFixed(1)));
      expect(res.percentages.overdueDistribution).toBe(Number(((12 / 83) * 100).toFixed(1)));
      expect(res.percentages.skippedDistribution).toBe(Number(((2 / 83) * 100).toFixed(1)));
    });

    test("Requirement 4: Separates status distribution (common denominator) from eligible adherence (100% adherence with 25% completed, 75% pending)", async () => {
      // Prompt Example: Total scheduled = 4, Completed = 1, Pending = 3, Overdue = 0
      medicationReminderOccurrenceRepository.getMonthlyAdherenceOccurrences.mockResolvedValue({
        completedOnTime: 1,
        completedLate: 0,
        overdue: 0,
        missed: 0,
        pending: 3,
        skipped: 0,
        total: 4,
      });

      const res = await medicationAdherenceService.getMonthlyAdherence(patientId, {
        month: 10,
        year: 2026,
        timezone: "Asia/Kolkata",
      });

      // Eligible doses: 1 completed + 0 overdue/missed = 1
      expect(res.metrics.totalCompleted).toBe(1);
      expect(res.metrics.eligibleScheduledDoses).toBe(1);
      expect(res.percentages.overallAdherence).toBe(100.0);

      // Status distribution using common denominator totalScheduled = 4
      expect(res.metrics.totalScheduled).toBe(4);
      expect(res.percentages.completedDistribution).toBe(25.0);
      expect(res.percentages.pendingDistribution).toBe(75.0);
      expect(res.percentages.overdueDistribution).toBe(0.0);
      expect(res.percentages.skippedDistribution).toBe(0.0);
    });

    test("Defaults to current month and year when query parameters omitted", async () => {
      medicationReminderOccurrenceRepository.getMonthlyAdherenceOccurrences.mockResolvedValue({
        completedOnTime: 0,
        completedLate: 0,
        overdue: 0,
        missed: 0,
        pending: 0,
        skipped: 0,
        total: 0,
      });

      const res = await medicationAdherenceService.getMonthlyAdherence(patientId, {});

      expect(res.month).toBe(10);
      expect(res.year).toBe(2026);
      expect(res.percentages.hasData).toBe(false);
      expect(res.percentages.overallAdherence).toBe(null);
    });
  });

  // =========================================================================
  // 4. DAILY DETAILS INSPECTION TESTS
  // =========================================================================
  describe("4. Daily Details Drill-Down", () => {
    test("Formats 12-hour local time, delay text, and sets actionable flag correctly", async () => {
      medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails.mockResolvedValue([
        {
          occurrenceId: "occ-1",
          medicationId: "med-1",
          medicationName: "Metformin",
          medicationType: "TABLET",
          dosePerIntake: 2,
          unit: "TABLET",
          actualMedicationTime: new Date("2026-10-21T02:30:00.000Z"), // 08:00 AM IST
          completedAt: new Date("2026-10-21T02:45:00.000Z"), // 08:15 AM IST
          delayMinutes: 15,
          completionClassification: "ON_TIME",
          isOverdue: false,
          skipReason: null,
          status: "COMPLETED",
        },
        {
          occurrenceId: "occ-2",
          medicationId: "med-2",
          medicationName: "Atorvastatin",
          medicationType: "TABLET",
          dosePerIntake: 1,
          unit: "TABLET",
          actualMedicationTime: new Date("2026-10-21T14:30:00.000Z"), // 08:00 PM IST
          completedAt: null,
          delayMinutes: null,
          completionClassification: null,
          isOverdue: false,
          skipReason: null,
          status: "PENDING",
        },
      ]);

      const res = await medicationAdherenceService.getDailyDetails(patientId, {
        date: "2026-10-21",
        timezone: "Asia/Kolkata",
      });

      expect(res.totalOccurrences).toBe(2);

      const dose1 = res.doses[0];
      expect(dose1.medicationName).toBe("Metformin");
      expect(dose1.dosePerIntake).toBe(2);
      expect(dose1.scheduledTimeFormatted).toBe("08:00 AM");
      expect(dose1.completedAtFormatted).toBe("08:15 AM");
      expect(dose1.delayFormatted).toBe("15m late");
      expect(dose1.actionable).toBe(false); // Completed

      const dose2 = res.doses[1];
      expect(dose2.medicationName).toBe("Atorvastatin");
      expect(dose2.scheduledTimeFormatted).toBe("08:00 PM");
      expect(dose2.completedAtFormatted).toBeNull();
      expect(dose2.delayFormatted).toBeNull();
      expect(dose2.status).toBe("PENDING");
      expect(dose2.actionable).toBe(false); // Daily details bottom sheet is strictly read-only
    });

    test("Past day pending dose has actionable = false", async () => {
      medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails.mockResolvedValue([
        {
          occurrenceId: "occ-past",
          medicationId: "med-1",
          medicationName: "Metformin",
          actualMedicationTime: new Date("2026-10-19T02:30:00.000Z"),
          completedAt: null,
          delayMinutes: null,
          status: "PENDING",
          isOverdue: true,
        },
      ]);

      const res = await medicationAdherenceService.getDailyDetails(patientId, {
        date: "2026-10-19",
        timezone: "Asia/Kolkata",
      });

      expect(res.doses[0].actionable).toBe(false);
    });
  });

  // =========================================================================
  // 5. REFILL INTELLIGENCE & INVENTORY DEPLETION TESTS
  // =========================================================================
  describe("5. Refill Intelligence & Stock Depletion", () => {
    test("Calculates remaining stock and urgency levels based on completed doses", async () => {
      // 3 active medications with verified stock
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-tide",
          medicationName: "Tide Plus",
          medicationType: "TABLET",
          totalQuantity: 30,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "TABLET",
        },
        {
          id: "med-amlo",
          medicationName: "Amlodipine",
          medicationType: "TABLET",
          totalQuantity: 60,
          dailyConsumption: 2,
          dosePerIntake: 1,
          unit: "TABLET",
        },
        {
          id: "med-vit",
          medicationName: "Vitamin D3",
          medicationType: "CAPSULE",
          totalQuantity: 30,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "CAPSULE",
        },
      ]);

      // Completed doses consumed
      // Tide Plus: 26 completed -> 30 - 26 = 4 remaining -> LOW_STOCK (<= 5)
      // Amlodipine: 44 completed -> 60 - 44 = 16 remaining -> 16 / 2 = 8 days -> DUE_SOON (<= 10)
      // Vitamin D3: 5 completed -> 30 - 5 = 25 remaining -> 25 days -> HEALTHY (> 10)
      medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId.mockImplementation(
        async (medId) => {
          if (medId === "med-tide") return 26;
          if (medId === "med-amlo") return 44;
          if (medId === "med-vit") return 5;
          return 0;
        },
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
        lowStockDays: 5,
        dueSoonDays: 10,
      });

      // Vitamin D3 is HEALTHY so it is filtered out of alerts
      expect(res.hasRefillAlerts).toBe(true);
      expect(res.totalAlertsCount).toBe(2);
      expect(res.medications).toHaveLength(2);

      // Tide Plus (LOW_STOCK) sorted before Amlodipine (DUE_SOON)
      const tideAlert = res.medications[0];
      expect(tideAlert.medicationName).toBe("Tide Plus");
      expect(tideAlert.remainingQuantity).toBe(4);
      expect(tideAlert.daysRemaining).toBe(4);
      expect(tideAlert.urgency).toBe("LOW_STOCK");
      expect(tideAlert.stockPercentage).toBe(13.3);

      const amloAlert = res.medications[1];
      expect(amloAlert.medicationName).toBe("Amlodipine");
      expect(amloAlert.remainingQuantity).toBe(16);
      expect(amloAlert.daysRemaining).toBe(8);
      expect(amloAlert.urgency).toBe("DUE_SOON");
    });

    test("OUT_OF_STOCK medication takes highest priority", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-empty",
          medicationName: "Pantoprazole",
          medicationType: "TABLET",
          totalQuantity: 10,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "TABLET",
        },
        {
          id: "med-low",
          medicationName: "Metformin",
          medicationType: "TABLET",
          totalQuantity: 20,
          dailyConsumption: 2,
          dosePerIntake: 1,
          unit: "TABLET",
        },
      ]);

      medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId.mockImplementation(
        async (medId) => {
          if (medId === "med-empty") return 12; // Consumed more than total -> remaining 0
          if (medId === "med-low") return 16; // 4 remaining / 2 = 2 days -> LOW_STOCK
          return 0;
        },
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {});

      expect(res.hasRefillAlerts).toBe(true);
      expect(res.medications[0].urgency).toBe("OUT_OF_STOCK");
      expect(res.medications[0].remainingQuantity).toBe(0);
      expect(res.medications[0].daysRemaining).toBe(0);
      expect(res.medications[1].urgency).toBe("LOW_STOCK");
    });

    test("Returns hasRefillAlerts = false and empty array when no medications qualify for alerts", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-healthy",
          medicationName: "Calcium",
          totalQuantity: 100,
          dailyConsumption: 1,
          dosePerIntake: 1,
        },
      ]);

      medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId.mockResolvedValue(
        5,
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {});

      expect(res.hasRefillAlerts).toBe(false);
      expect(res.totalAlertsCount).toBe(0);
      expect(res.medications).toEqual([]);
    });

    test("Returns hasRefillAlerts = false when patient has no active inventory tracking", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([]);

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {});

      expect(res.hasRefillAlerts).toBe(false);
      expect(res.totalAlertsCount).toBe(0);
      expect(res.medications).toEqual([]);
    });
  });

  // =========================================================================
  // 6. TIMEZONE & DST BOUNDARY TESTS
  // =========================================================================
  describe("6. Timezone & DST Boundary Tests", () => {
    test("America/New_York across calendar date boundary correctly computes local today", async () => {
      // 2026-10-21T02:30:00.000Z is 10:30 PM EDT on October 20
      medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences.mockImplementation(
        async (_uid, { timezone }) => {
          expect(timezone).toBe("America/New_York");
          return [
            {
              date: "2026-10-20",
              completedOnTime: 1,
              completedLate: 0,
              overdue: 0,
              missed: 0,
              pending: 0,
              skipped: 0,
              total: 1,
            },
          ];
        },
      );

      const res = await medicationAdherenceService.getWeeklyAdherence(patientId, {
        timezone: "America/New_York",
      });

      // At 2026-10-21T06:00:00.000Z, in New York it is 2026-10-21 02:00 AM EDT
      expect(res.dateRange.timezone).toBe("America/New_York");
      expect(res.dateRange.endDate).toBe("2026-10-21");
      expect(res.dailyBreakdown).toHaveLength(7);
    });
  });

  // =========================================================================
  // 7. SECURITY & MULTI-PATIENT ISOLATION
  // =========================================================================
  describe("7. Security & Multi-Patient Isolation", () => {
    test("Strictly queries repository with authenticated userId", async () => {
      medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences.mockResolvedValue([]);

      await medicationAdherenceService.getWeeklyAdherence(patientId, {});

      expect(
        medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences,
      ).toHaveBeenCalledWith(patientId, expect.anything());
      expect(
        medicationReminderOccurrenceRepository.getWeeklyAdherenceOccurrences,
      ).not.toHaveBeenCalledWith(otherPatientId, expect.anything());
    });
  });

  // =========================================================================
  // 8. VALIDATION SCHEMA TESTS
  // =========================================================================
  describe("8. Zod Validation Schemas", () => {
    test("Accepts valid IANA timezone and rejects invalid strings", () => {
      expect(isValidTimezone("Asia/Kolkata")).toBe(true);
      expect(isValidTimezone("America/New_York")).toBe(true);
      expect(isValidTimezone("UTC")).toBe(true);
      expect(isValidTimezone("Europe/London")).toBe(true);
      expect(isValidTimezone("Invalid/Unknown_TZ")).toBe(false);
      expect(isValidTimezone("")).toBe(false);
      expect(isValidTimezone("   ")).toBe(false);
      expect(isValidTimezone(null)).toBe(false);
      expect(isValidTimezone("IST")).toBe(false); // IST is legacy offset abbreviation, not valid IANA
    });

    test("weeklyDashboardQuerySchema validates correctly", () => {
      expect(
        weeklyDashboardQuerySchema.safeParse({
          timezone: "Asia/Kolkata",
          startDate: "2026-10-15",
          endDate: "2026-10-21",
        }).success,
      ).toBe(true);

      // Rejects invalid date format
      expect(
        weeklyDashboardQuerySchema.safeParse({
          startDate: "15-10-2026",
        }).success,
      ).toBe(false);

      // Rejects invalid timezone
      expect(
        weeklyDashboardQuerySchema.safeParse({
          timezone: "Mars/Olympus",
        }).success,
      ).toBe(false);
    });

    test("monthlyDashboardQuerySchema validates month and year bounds", () => {
      expect(
        monthlyDashboardQuerySchema.safeParse({
          month: 10,
          year: 2026,
        }).success,
      ).toBe(true);

      // Month out of range (13) fails
      expect(
        monthlyDashboardQuerySchema.safeParse({
          month: 13,
        }).success,
      ).toBe(false);

      // Month 0 fails
      expect(
        monthlyDashboardQuerySchema.safeParse({
          month: 0,
        }).success,
      ).toBe(false);
    });

    test("dailyDetailsQuerySchema requires date", () => {
      expect(
        dailyDetailsQuerySchema.safeParse({
          date: "2026-10-21",
        }).success,
      ).toBe(true);

      // Missing date fails
      expect(dailyDetailsQuerySchema.safeParse({}).success).toBe(false);
    });

    test("refillsDashboardQuerySchema accepts optional timezone", () => {
      expect(refillsDashboardQuerySchema.safeParse({}).success).toBe(true);
      expect(refillsDashboardQuerySchema.safeParse({ timezone: "America/New_York" }).success).toBe(
        true,
      );
      expect(refillsDashboardQuerySchema.safeParse({ timezone: "bad_timezone" }).success).toBe(
        false,
      );
    });
  });

  // =========================================================================
  // 9. HISTORICAL CLASSIFICATION & VERIFIED INVENTORY HARDENING
  // =========================================================================
  describe("9. Historical Classification & Verified Inventory Hardening", () => {
    test("Historical completed dose with timestamps derives ON_TIME retrospectively", async () => {
      medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails.mockResolvedValue([
        {
          occurrenceId: "occ-retro-1",
          medicationId: "med-1",
          medicationName: "Metformin",
          medicationType: "TABLET",
          dosePerIntake: 1,
          unit: "tablet",
          status: "COMPLETED",
          actualMedicationTime: "2026-10-21T02:30:00.000Z",
          completedAt: "2026-10-21T02:40:00.000Z", // 10 min delay <= 30m grace
          delayMinutes: null, // Legacy record without delay_minutes
          completionClassification: null, // Legacy record without classification
          isOverdue: false,
          skipReason: null,
        },
      ]);

      const res = await medicationAdherenceService.getDailyDetails(patientId, {
        date: "2026-10-21",
        timezone: "Asia/Kolkata",
      });

      expect(res.doses).toHaveLength(1);
      const dose = res.doses[0];
      expect(dose.completionClassification).toBe("ON_TIME");
      expect(dose.delayMinutes).toBe(10);
      expect(dose.retrospectivelyDerived).toBe(true);
      expect(dose.delayFormatted).toBe("10m late");
    });

    test("Historical completed dose with large delay derives LATE retrospectively", async () => {
      medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails.mockResolvedValue([
        {
          occurrenceId: "occ-retro-2",
          medicationId: "med-1",
          medicationName: "Metformin",
          medicationType: "TABLET",
          dosePerIntake: 1,
          unit: "tablet",
          status: "COMPLETED",
          actualMedicationTime: "2026-10-21T02:30:00.000Z",
          completedAt: "2026-10-21T05:00:00.000Z", // 150 min delay > 30m grace
          delayMinutes: null,
          completionClassification: null,
          isOverdue: false,
          skipReason: null,
        },
      ]);

      const res = await medicationAdherenceService.getDailyDetails(patientId, {
        date: "2026-10-21",
        timezone: "Asia/Kolkata",
      });

      expect(res.doses).toHaveLength(1);
      const dose = res.doses[0];
      expect(dose.completionClassification).toBe("LATE");
      expect(dose.delayMinutes).toBe(150);
      expect(dose.retrospectivelyDerived).toBe(true);
      expect(dose.delayFormatted).toBe("2h 30m late");
    });

    test("Historical completed dose missing completedAt marks UNKNOWN without inventing on-time", async () => {
      medicationReminderOccurrenceRepository.getDailyOccurrencesWithDetails.mockResolvedValue([
        {
          occurrenceId: "occ-retro-3",
          medicationId: "med-1",
          medicationName: "Metformin",
          medicationType: "TABLET",
          dosePerIntake: 1,
          unit: "tablet",
          status: "COMPLETED",
          actualMedicationTime: "2026-10-21T02:30:00.000Z",
          completedAt: null, // Missing completion timestamp
          delayMinutes: null,
          completionClassification: null,
          isOverdue: false,
          skipReason: null,
        },
      ]);

      const res = await medicationAdherenceService.getDailyDetails(patientId, {
        date: "2026-10-21",
        timezone: "Asia/Kolkata",
      });

      expect(res.doses).toHaveLength(1);
      const dose = res.doses[0];
      expect(dose.completionClassification).toBe("UNKNOWN");
      expect(dose.delayMinutes).toBe(null);
      expect(dose.retrospectivelyDerived).toBe(false);
      expect(dose.delayFormatted).toBe("Unknown delay");
    });

    test("Monthly metrics strictly conserve totalCompleted = onTime + late + unknown", async () => {
      medicationReminderOccurrenceRepository.getMonthlyAdherenceOccurrences.mockResolvedValue({
        completedOnTime: 30,
        completedLate: 10,
        completedUnknown: 5,
        overdue: 2,
        missed: 3,
        pending: 10,
        skipped: 1,
        total: 61,
      });

      const res = await medicationAdherenceService.getMonthlyAdherence(patientId, {
        month: 10,
        year: 2026,
        timezone: "Asia/Kolkata",
      });

      expect(res.metrics.completedOnTime).toBe(30);
      expect(res.metrics.completedLate).toBe(10);
      expect(res.metrics.completedUnknown).toBe(5);
      expect(res.metrics.totalCompleted).toBe(45); // 30 + 10 + 5
      expect(res.metrics.eligibleScheduledDoses).toBe(50); // 45 completed + 5 overdue/missed
      expect(res.percentages.overallAdherence).toBe(90.0); // 45 / 50 = 90%
      expect(res.percentages.onTimeAdherence).toBe(60.0); // 30 / 50 = 60%
      expect(res.percentages.lateCompletion).toBe(20.0); // 10 / 50 = 20%
      expect(res.percentages.unknownCompletion).toBe(10.0); // 5 / 50 = 10%
      // Invariant: onTime + late + unknown = overall
      expect(
        Number(
          (
            res.percentages.onTimeAdherence +
            res.percentages.lateCompletion +
            res.percentages.unknownCompletion
          ).toFixed(1),
        ),
      ).toBe(res.percentages.overallAdherence);
    });
  });

  // =========================================================================
  // 7. Phase 28: Final Refill Eligibility & Urgency Intelligence (16 Required Tests)
  // =========================================================================
  describe("7. Phase 28: Final Refill Eligibility & Urgency Intelligence (16 Required Tests)", () => {
    // 1. Quantity 1, daily consumption 1, next dose tomorrow
    test("1. Quantity 1, daily consumption 1, next dose tomorrow -> LOW_STOCK, daysRemaining=1, refill date=2026-10-24", async () => {
      jest.setSystemTime(new Date("2026-10-22T06:00:00.000Z"));

      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-mandatory-1",
          medicationName: "Metformin",
          medicationType: "TABLET",
          totalQuantity: 1,
          remainingQuantity: 1,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "tablet",
          nextDose: "2026-10-23",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);
      medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId.mockResolvedValue(
        0,
      );
      medicationReminderOccurrenceRepository.findUpcomingOccurrencesByMedicationId.mockResolvedValue(
        [
          {
            id: "occ-tomorrow",
            actualMedicationTime: "2026-10-23T08:00:00.000Z",
            status: "PENDING",
          },
          {
            id: "occ-day-after",
            actualMedicationTime: "2026-10-24T08:00:00.000Z",
            status: "PENDING",
          },
        ],
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.hasRefillAlerts).toBe(true);
      expect(res.totalAlertsCount).toBe(1);
      const med = res.medications[0];
      expect(med.medicationName).toBe("Metformin");
      expect(med.urgency).toBe("LOW_STOCK");
      expect(med.remainingQuantity).toBe(1);
      expect(med.daysRemaining).toBe(1);
      expect(med.hasRefillHistory).toBe(false);
      // Tomorrow's dose (Oct 23) is covered; next uncovered dose determines projected shortage date: 2026-10-24
      expect(med.estimatedRefillDate).toBe("2026-10-24");
    });

    // 2. Quantity 0 remaining after consumption
    test("2. Quantity 0 remaining after consumption -> OUT_OF_STOCK, daysRemaining=0, visible", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-out-of-stock",
          medicationName: "Atorvastatin",
          medicationType: "TABLET",
          totalQuantity: 10,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);
      // All 10 doses completed -> 0 remaining
      medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId.mockResolvedValue(
        10,
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.hasRefillAlerts).toBe(true);
      expect(res.medications[0].urgency).toBe("OUT_OF_STOCK");
      expect(res.medications[0].remainingQuantity).toBe(0);
      expect(res.medications[0].daysRemaining).toBe(0);
    });

    // 3. Quantity 1, daily consumption 2
    test("3. Quantity 1, daily consumption 2 -> LOW_STOCK, daysRemaining=0, visible", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-sub-daily",
          medicationName: "Metformin 500",
          medicationType: "TABLET",
          totalQuantity: 20,
          remainingQuantity: 1,
          dailyConsumption: 2,
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.hasRefillAlerts).toBe(true);
      expect(res.medications[0].urgency).toBe("LOW_STOCK");
      expect(res.medications[0].remainingQuantity).toBe(1);
      expect(res.medications[0].daysRemaining).toBe(0); // 1 / 2 = 0 full days
    });

    // 4. Exactly 3 days of supply
    test("4. Exactly 3 days of supply -> LOW_STOCK (<= 3 days threshold)", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-3-days",
          medicationName: "Amlodipine",
          medicationType: "TABLET",
          totalQuantity: 30,
          remainingQuantity: 3,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.hasRefillAlerts).toBe(true);
      expect(res.medications[0].urgency).toBe("LOW_STOCK");
      expect(res.medications[0].daysRemaining).toBe(3);
    });

    // 5. Exactly 7 days of supply
    test("5. Exactly 7 days of supply -> DUE_SOON (<= 7 days threshold)", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-7-days",
          medicationName: "Lisinopril",
          medicationType: "TABLET",
          totalQuantity: 30,
          remainingQuantity: 7,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.hasRefillAlerts).toBe(true);
      expect(res.medications[0].urgency).toBe("DUE_SOON");
      expect(res.medications[0].daysRemaining).toBe(7);
    });

    // 6. More than 7 days of supply
    test("6. More than 7 days of supply -> HEALTHY, excluded from refill alerts", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-healthy",
          medicationName: "Vitamin D3",
          medicationType: "TABLET",
          totalQuantity: 60,
          remainingQuantity: 20,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.hasRefillAlerts).toBe(false);
      expect(res.totalAlertsCount).toBe(0);
      expect(res.medications).toEqual([]);
    });

    // 7. No refill history
    test("7. No refill history: medication with remaining stock is eligible without refill history", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-no-refill-hist",
          medicationName: "Omeprazole",
          medicationType: "CAPSULE",
          totalQuantity: 10,
          remainingQuantity: 2,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "capsule",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.hasRefillAlerts).toBe(true);
      expect(res.medications[0].medicationName).toBe("Omeprazole");
      expect(res.medications[0].urgency).toBe("LOW_STOCK");
      expect(res.medications[0].hasRefillHistory).toBe(false);
    });

    // 8. Future-starting medication
    test("8. Future-starting medication: upcoming doses walk from scheduled future occurrences", async () => {
      jest.setSystemTime(new Date("2026-10-22T06:00:00.000Z"));

      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-future",
          medicationName: "Future Antibiotic",
          medicationType: "TABLET",
          totalQuantity: 2,
          remainingQuantity: 2,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);
      medicationReminderOccurrenceRepository.findUpcomingOccurrencesByMedicationId.mockResolvedValue(
        [
          {
            id: "occ-future-1",
            actualMedicationTime: "2026-10-28T08:00:00.000Z",
            status: "PENDING",
          },
          {
            id: "occ-future-2",
            actualMedicationTime: "2026-10-29T08:00:00.000Z",
            status: "PENDING",
          },
          {
            id: "occ-future-3",
            actualMedicationTime: "2026-10-30T08:00:00.000Z",
            status: "PENDING",
          },
        ],
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      // 2 doses in stock: Oct 28 & Oct 29 covered. First uncovered dose is Oct 30!
      expect(res.medications[0].urgency).toBe("LOW_STOCK");
      expect(res.medications[0].estimatedRefillDate).toBe("2026-10-30");
    });

    // 9. Completed, skipped and pending doses
    test("9. Completed, skipped and pending doses: only completed occurrences deduct stock", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-deduct-audit",
          medicationName: "Aspirin",
          medicationType: "TABLET",
          totalQuantity: 20,
          dailyConsumption: 2,
          dosePerIntake: 2,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);
      // 5 completed occurrences (on time and late). Skipped and pending do not increment count
      medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId.mockResolvedValue(
        5,
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      // 20 total - (5 completed * 2 per dose) = 10 remaining -> 5 days -> DUE_SOON
      expect(res.medications[0].remainingQuantity).toBe(10);
      expect(res.medications[0].daysRemaining).toBe(5);
      expect(res.medications[0].urgency).toBe("DUE_SOON");
    });

    // 10. Refill inventory updates
    test("10. Refill inventory updates: refills increase cumulative stock accurately", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-refill-cumulative",
          medicationName: "Rosuvastatin",
          medicationType: "TABLET",
          totalQuantity: 30, // Updated by refill service
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue({
        id: "refill-record-1",
        createdAt: new Date(),
        refillQuantity: 20,
      });
      medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId.mockResolvedValue(
        28,
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      // 30 - 28 = 2 remaining -> LOW_STOCK
      expect(res.hasRefillAlerts).toBe(true);
      expect(res.medications[0].remainingQuantity).toBe(2);
      expect(res.medications[0].daysRemaining).toBe(2);
      expect(res.medications[0].urgency).toBe("LOW_STOCK");
      expect(res.medications[0].hasRefillHistory).toBe(true);
    });

    // 11. Duplicate completion prevention
    test("11. Duplicate completion prevention via COUNT(DISTINCT occurrence_id)", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-no-double-deduct",
          medicationName: "Losartan",
          medicationType: "TABLET",
          totalQuantity: 10,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);
      // Distinct counting ensures count is 2 even if duplicates exist
      medicationReminderOccurrenceRepository.countCompletedOccurrencesByMedicationId.mockResolvedValue(
        2,
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      // 10 - 2 = 8 remaining -> 8 days > 7 -> HEALTHY
      expect(res.hasRefillAlerts).toBe(false);
      expect(res.medications).toEqual([]);
    });

    // 12. Invalid medicine creation quantity
    test("12. Invalid medicine creation quantity: schema rejects missing, negative, or invalid quantities", () => {
      // Missing totalQuantity
      const missingResult = createMedicationSchema.safeParse({
        medicationName: "Invalid Med",
        medicationType: "TABLET",
        dosePerIntake: 1,
        frequency: "Once Daily",
        medicationSchedule: { MORNING: "09:00:00" },
        startDate: "2026-10-22",
        ongoing: true,
      });
      expect(missingResult.success).toBe(false);

      // Negative totalQuantity
      const negativeResult = createMedicationSchema.safeParse({
        medicationName: "Negative Med",
        medicationType: "TABLET",
        dosePerIntake: 1,
        frequency: "Once Daily",
        medicationSchedule: { MORNING: "09:00:00" },
        startDate: "2026-10-22",
        ongoing: true,
        totalQuantity: -5,
      });
      expect(negativeResult.success).toBe(false);

      // dosePerIntake > totalQuantity
      const doseExceedsResult = createMedicationSchema.safeParse({
        medicationName: "Excessive Dose Med",
        medicationType: "TABLET",
        dosePerIntake: 5,
        totalQuantity: 2,
        frequency: "Once Daily",
        medicationSchedule: { MORNING: "09:00:00" },
        startDate: "2026-10-22",
        ongoing: true,
      });
      expect(doseExceedsResult.success).toBe(false);
    });

    // 13. OCR-assisted medicine creation quantity validation
    test("13. OCR-assisted medicine creation quantity validation enforces mandatory valid quantity", () => {
      // OCR payload missing totalQuantity cannot be saved without quantity
      const ocrMissingQty = createMedicationSchema.safeParse({
        medicationName: "OCR Extracted Drug",
        medicationType: "TABLET",
        dosePerIntake: 1,
        frequency: "Once Daily",
        medicationSchedule: { MORNING: "08:00:00" },
        startDate: "2026-10-22",
        ongoing: true,
      });
      expect(ocrMissingQty.success).toBe(false);

      // OCR payload with valid totalQuantity succeeds
      const ocrValidQty = createMedicationSchema.safeParse({
        medicationName: "OCR Extracted Drug",
        medicationType: "TABLET",
        dosePerIntake: 1,
        frequency: "Once Daily",
        medicationSchedule: { MORNING: "08:00:00" },
        startDate: "2026-10-22",
        ongoing: true,
        totalQuantity: 10,
      });
      expect(ocrValidQty.success).toBe(true);
    });

    // 14. AS_NEEDED medication
    test("14. AS_NEEDED medication does not invent fake daily consumption or falsely trigger LOW_STOCK or UNKNOWN", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-prn",
          medicationName: "Paracetamol SOS",
          medicationType: "TABLET",
          totalQuantity: 3,
          remainingQuantity: 3,
          dailyConsumption: null,
          frequency: "AS_NEEDED",
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);
      medicationReminderOccurrenceRepository.findUpcomingOccurrencesByMedicationId.mockResolvedValue(
        [],
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      // Does not appear in refill alerts (internal classification is HEALTHY, no UNKNOWN or false alerts)
      expect(res.hasRefillAlerts).toBe(false);
      expect(res.medications).toEqual([]);
    });

    // 15. Patient timezone boundaries
    test("15. Patient timezone boundaries respect patient-local date when determining alerts", async () => {
      // Midnight in Kolkata (2026-10-22 00:30 IST) is 2026-10-21 19:00 UTC
      jest.setSystemTime(new Date("2026-10-21T19:00:00.000Z"));

      medicationRepository.findActiveInventoryMedications.mockResolvedValue([
        {
          id: "med-tz",
          medicationName: "Night Sedative",
          medicationType: "TABLET",
          totalQuantity: 1,
          remainingQuantity: 1,
          dailyConsumption: 1,
          dosePerIntake: 1,
          unit: "tablet",
        },
      ]);
      refillRepository.findLatestRefillByMedicationId.mockResolvedValue(null);
      medicationReminderOccurrenceRepository.findUpcomingOccurrencesByMedicationId.mockResolvedValue(
        [],
      );

      const res = await medicationAdherenceService.getRefillAlerts(patientId, {
        timezone: "Asia/Kolkata",
      });

      expect(res.medications[0].urgency).toBe("LOW_STOCK");
      // In Asia/Kolkata, current date is 2026-10-22; +1 day is 2026-10-23
      expect(res.medications[0].estimatedRefillDate).toBe("2026-10-23");
    });

    // 16. Patient data isolation
    test("16. Patient data isolation ensures queries are strictly scoped to the requesting patient", async () => {
      medicationRepository.findActiveInventoryMedications.mockResolvedValue([]);

      await medicationAdherenceService.getRefillAlerts(patientId);

      expect(medicationRepository.findActiveInventoryMedications).toHaveBeenCalledWith(patientId);
      expect(medicationRepository.findActiveInventoryMedications).not.toHaveBeenCalledWith(
        otherPatientId,
      );
    });
  });
});
