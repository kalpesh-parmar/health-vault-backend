const reminderService = require("../../src/services/reminder.service");
const medicationReminderOccurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const notificationRepository = require("../../src/repositories/notificationRepository");
const reminderNotificationService = require("../../src/services/reminderNotification.service");
const { reminderOccurrenceStatus } = require("../../src/enums/reminderOccurrenceStatus");
const { reminderTypes } = require("../../src/enums/reminderTypes");

jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/repositories/notificationRepository");
jest.mock("../../src/services/reminderNotification.service");

describe("Medication Reminder Notification & Deduplication Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.useFakeTimers();
    jest.setSystemTime(new Date("2026-06-01T08:00:00.000Z"));
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  const buildReminderFixture = (actualMedicationTime, reminderBeforeMinutes = 5) => ({
    occurrence: {
      id: "occurrence-100",
      actualMedicationTime,
      patientId: "patient-1",
      status: reminderOccurrenceStatus.PENDING,
      isOverdue: false,
    },
    medication: {
      id: "med-100",
      userId: "patient-1",
      medicationName: "Atorvastatin 20mg",
      reminderBeforeMinutes,
    },
  });

  test("dispatches BEFORE notification when current time is within reminder window and not yet sent", async () => {
    // Dose at 08:04:00 (4 minutes ahead of now 08:00:00), reminderBeforeMinutes = 5
    // beforeTime is 07:59:00. now (08:00:00) is between beforeTime (07:59:00) and actualMed (08:04:00).
    const actualMedTime = new Date("2026-06-01T08:04:00.000Z");
    const reminderFixture = buildReminderFixture(actualMedTime, 5);

    medicationReminderOccurrenceRepository.findPendingReminders.mockResolvedValue([
      reminderFixture,
    ]);
    notificationRepository.findReminderNotificationSent.mockResolvedValue(null); // Not sent yet

    await reminderService.sendReminder();

    expect(notificationRepository.findReminderNotificationSent).toHaveBeenCalledWith(
      "patient-1",
      "occurrence-100",
      reminderTypes.BEFORE,
    );
    expect(reminderNotificationService.sendReminderNotification).toHaveBeenCalledWith(
      reminderFixture,
      reminderTypes.BEFORE,
    );
  });

  test("deduplicates and does NOT send BEFORE notification if already sent in DB", async () => {
    const actualMedTime = new Date("2026-06-01T08:04:00.000Z");
    const reminderFixture = buildReminderFixture(actualMedTime, 5);

    medicationReminderOccurrenceRepository.findPendingReminders.mockResolvedValue([
      reminderFixture,
    ]);
    notificationRepository.findReminderNotificationSent.mockResolvedValue({
      id: "notif-already-sent",
    });

    await reminderService.sendReminder();

    expect(notificationRepository.findReminderNotificationSent).toHaveBeenCalledWith(
      "patient-1",
      "occurrence-100",
      reminderTypes.BEFORE,
    );
    expect(reminderNotificationService.sendReminderNotification).not.toHaveBeenCalled();
  });

  test("marks occurrence as isOverdue once actual medication time has passed", async () => {
    // Dose was at 07:55:00, now is 08:00:00
    const actualMedTime = new Date("2026-06-01T07:55:00.000Z");
    const reminderFixture = buildReminderFixture(actualMedTime, 5);

    medicationReminderOccurrenceRepository.findPendingReminders.mockResolvedValue([
      reminderFixture,
    ]);
    notificationRepository.findReminderNotificationSent.mockResolvedValue(null);

    await reminderService.sendReminder();

    expect(medicationReminderOccurrenceRepository.update).toHaveBeenCalledWith("occurrence-100", {
      isOverdue: true,
    });
    expect(reminderFixture.occurrence.isOverdue).toBe(true);
  });

  test("dispatches AFTER notification when past afterReminderTime and not yet sent", async () => {
    // Dose at 07:44:00, default env afterReminderMinutes is 15 min -> afterTime is 07:59:00
    // now is 08:00:00 (within 15 min window after 07:59:00)
    const actualMedTime = new Date("2026-06-01T07:44:00.000Z");
    const reminderFixture = buildReminderFixture(actualMedTime, 5);
    reminderFixture.occurrence.isOverdue = true;

    medicationReminderOccurrenceRepository.findPendingReminders.mockResolvedValue([
      reminderFixture,
    ]);
    notificationRepository.findReminderNotificationSent.mockResolvedValue(null);

    await reminderService.sendReminder();

    expect(notificationRepository.findReminderNotificationSent).toHaveBeenCalledWith(
      "patient-1",
      "occurrence-100",
      reminderTypes.AFTER,
    );
    expect(reminderNotificationService.sendReminderNotification).toHaveBeenCalledWith(
      reminderFixture,
      reminderTypes.AFTER,
    );
  });

  test("dispatches OVERDUE follow-up notification when 30 mins past afterTime and not yet sent", async () => {
    // Dose at 07:14:00 -> afterTime is 07:29:00 -> overdueTime (+30m) is 07:59:00
    // now is 08:00:00 (within 15 min window after 07:59:00)
    const actualMedTime = new Date("2026-06-01T07:14:00.000Z");
    const reminderFixture = buildReminderFixture(actualMedTime, 5);
    reminderFixture.occurrence.isOverdue = true;

    medicationReminderOccurrenceRepository.findPendingReminders.mockResolvedValue([
      reminderFixture,
    ]);
    notificationRepository.findReminderNotificationSent.mockResolvedValue(null);

    await reminderService.sendReminder();

    expect(notificationRepository.findReminderNotificationSent).toHaveBeenCalledWith(
      "patient-1",
      "occurrence-100",
      "OVERDUE",
    );
    expect(reminderNotificationService.sendOverdueNotification).toHaveBeenCalledWith(
      reminderFixture,
    );
  });
});
