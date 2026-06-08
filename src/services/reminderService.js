// repositories/services
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const medicationRepository = require("../repositories/medicationRepository");
const {
  beforeReminderTime,
  afterReminderTime,
  isSameMinute,
} = require("../utils/reminderOccurrenceGenerator");
const reminderNotificationService = require("./reminderNotificationService");
const { reminderTypes } = require("../enums/reminderTypes");

class ReminderService {
  //WRAP TWO FUNCTION IN ONE
  async processReminders() {
    await this.sendReminder();
    await this.sendRefillAlert();
  }
  // 1. SEND REMINDERS (EVERY MINUTE)
  async sendReminder() {
    const reminders = await medicationReminderOccurrenceRepository.findPendingReminders([
      reminderOccurrenceStatus.PENDING,
    ]);
    for (const reminder of reminders) {
      try {
        const { occurrence, medication } = reminder;
        const now = new Date();
        const beforeTime = beforeReminderTime(
          occurrence.actualMedicationTime,
          medication.reminderBeforeMinutes,
        );

        const afterTime = afterReminderTime(occurrence.actualMedicationTime);

        // 1. Send Main Reminder Notification
        if (beforeTime && isSameMinute(now, beforeTime)) {
          await reminderNotificationService.sendReminderNotification(
            reminder,
            reminderTypes.BEFORE,
          );
        }
        //MARK AS FOLLOW UP TRUE AFTER ACTUAL MEDICATION TIME
        if (
          !occurrence.isOverdue &&
          now >= new Date(occurrence.actualMedicationTime) &&
          occurrence.status == reminderOccurrenceStatus.PENDING
        ) {
          await medicationReminderOccurrenceRepository.update(occurrence.id, {
            isOverdue: true,
          });
        }

        // 2. Send after Notification
        if (
          occurrence.isOverdue &&
          occurrence.status == reminderOccurrenceStatus.PENDING &&
          isSameMinute(now, afterTime)
        ) {
          await reminderNotificationService.sendReminderNotification(reminder, reminderTypes.AFTER);
        }

        //3. send follow up notification if 30 mins overdue and not marked as skipped
        if (
          !occurrence.overdueNotificationSent &&
          occurrence.status === reminderOccurrenceStatus.PENDING &&
          isSameMinute(now, new Date(afterTime.getTime() + 30 * 60 * 1000))
        ) {
          await reminderNotificationService.sendOverdueNotification(reminder);
        }
      } catch (err) {
        console.error("Reminder failed:", err);
      }
    }
  }
  // 2. SEND REFILL ALERTS REMINDERS
  async sendRefillAlert() {
    const medications = await medicationRepository.findMedicationsForRefillAlert(true);
    const now = new Date();

    const hour = now.getHours();
    const minute = now.getMinutes();

    const isReminderTime = (hour === 10 && minute === 0) || (hour === 19 && minute === 0);
    if (!isReminderTime) {
      return;
    }

    const seenMedicationIds = new Set();
    for (const medication of medications) {
      const medicationId = medication.medication.id;
      if (seenMedicationIds.has(medicationId)) {
        continue;
      }
      seenMedicationIds.add(medicationId);
      try {
        await reminderNotificationService.sendReminderNotification(
          medication,
          reminderTypes.REFILL,
        );
        await medicationReminderOccurrenceRepository.clearRefillReminderTime(medicationId);
      } catch (err) {
        console.error(`Refill alert failed for medication ${medicationId}`, err);
      }
    }
  }
}
module.exports = new ReminderService();
