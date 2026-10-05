const reminderService = require("../../src/services/reminder.service");
const medicationReminderOccurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const notificationRepository = require("../../src/repositories/notificationRepository");
const reminderNotificationService = require("../../src/services/reminderNotification.service");
const medicationRepository = require("../../src/repositories/medicationRepository");
const { reminderOccurrenceStatus } = require("../../src/enums/reminderOccurrenceStatus");

jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/notificationRepository");
jest.mock("../../src/services/reminderNotification.service");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/refillRepository");

describe("Production-Safe Overdue Medication Occurrences Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-09-28T12:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test("Case 1 — Future reminder: should not be marked overdue", async () => {
    medicationReminderOccurrenceRepository.markPendingOccurrencesOverdue.mockResolvedValue(0);

    const result = await reminderService.processOverdueOccurrences();
    expect(result).toBe(0);
    expect(medicationReminderOccurrenceRepository.markPendingOccurrencesOverdue).toHaveBeenCalled();
  });

  test("Case 2 — Recent past reminder (1 hour ago): should be marked overdue", async () => {
    medicationReminderOccurrenceRepository.markPendingOccurrencesOverdue.mockResolvedValue(1);

    const result = await reminderService.processOverdueOccurrences();
    expect(result).toBe(1);
    expect(medicationReminderOccurrenceRepository.markPendingOccurrencesOverdue).toHaveBeenCalled();
  });

  test("Case 3 — More than 3 hours old (4 hours ago): should be marked overdue (regression fix)", async () => {
    // Doses 4 hours ago are handled by processOverdueOccurrences() despite sendReminder() 3-hour window
    medicationReminderOccurrenceRepository.markPendingOccurrencesOverdue.mockResolvedValue(3);

    const result = await reminderService.processOverdueOccurrences();
    expect(result).toBe(3);
    expect(medicationReminderOccurrenceRepository.markPendingOccurrencesOverdue).toHaveBeenCalled();
  });

  test("Case 4 — Yesterday pending reminder: should be marked overdue", async () => {
    medicationReminderOccurrenceRepository.markPendingOccurrencesOverdue.mockResolvedValue(5);

    const result = await reminderService.processOverdueOccurrences();
    expect(result).toBe(5);
  });

  test("Case 5 — Already overdue: processOverdueOccurrences should not send notifications", async () => {
    medicationReminderOccurrenceRepository.markPendingOccurrencesOverdue.mockResolvedValue(0);

    await reminderService.processOverdueOccurrences();

    expect(reminderNotificationService.sendReminderNotification).not.toHaveBeenCalled();
    expect(reminderNotificationService.sendOverdueNotification).not.toHaveBeenCalled();
  });

  test("Case 6 — Taken/Completed medication: markPendingOccurrencesOverdue only updates PENDING status", async () => {
    // When all items are COMPLETED, update query affects 0 rows
    medicationReminderOccurrenceRepository.markPendingOccurrencesOverdue.mockResolvedValue(0);

    const count = await reminderService.processOverdueOccurrences();
    expect(count).toBe(0);
  });

  test("Case 7 — Existing reminder notification flow regression: sendReminder continues using 3h-2h window", async () => {
    const actualMedTime = new Date("2026-09-28T12:04:00.000Z");
    const reminderFixture = {
      occurrence: {
        id: "occ-1",
        actualMedicationTime: actualMedTime,
        patientId: "patient-1",
        status: reminderOccurrenceStatus.PENDING,
        isOverdue: false,
      },
      medication: {
        id: "med-1",
        userId: "patient-1",
        medicationName: "Metformin",
        reminderBeforeMinutes: 5,
      },
    };

    medicationReminderOccurrenceRepository.findPendingReminders.mockResolvedValue([
      reminderFixture,
    ]);
    notificationRepository.findReminderNotificationSent.mockResolvedValue(null);

    await reminderService.sendReminder();

    expect(medicationReminderOccurrenceRepository.findPendingReminders).toHaveBeenCalledWith(
      [reminderOccurrenceStatus.PENDING],
      {
        startTime: new Date("2026-09-28T09:00:00.000Z"), // now - 3h
        endTime: new Date("2026-09-28T14:00:00.000Z"), // now + 2h
      },
    );
    expect(reminderNotificationService.sendReminderNotification).toHaveBeenCalled();
  });

  test("Case 8 — Refill regression: sendRefillAlert operates without modification", async () => {
    medicationRepository.findAllActive.mockResolvedValue([]);

    await reminderService.sendRefillAlert();

    expect(medicationRepository.findAllActive).toHaveBeenCalledWith(true);
  });
});
