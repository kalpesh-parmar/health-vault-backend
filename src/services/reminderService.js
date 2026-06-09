// repositories/services
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const medicationRepository = require("../repositories/medicationRepository");
const {
  refillTime,
} = require("../utils/reminderOccurrenceGenerator");
const reminderNotificationService = require("./reminderNotificationService");
const { reminderTypes } = require("../enums/reminderTypes");
const { now } = require("moment-timezone");

class ReminderService {
  // 1. SEND REMINDERS (EVERY MINUTE)
  async sendReminder() {
    const reminders = await medicationReminderOccurrenceRepository.findPendingReminders([
      reminderOccurrenceStatus.PENDING,
      reminderOccurrenceStatus.SENT,
    ]);
    // console.log("reminders===",reminders);

    for (const reminder of reminders) {
      try {
        const { occurrence } = reminder;
        const overdueTime = new Date(new Date(occurrence.scheduledAt).getTime() + 1 * 60 * 1000);
        // mark overdue
        if (occurrence.status === reminderOccurrenceStatus.SENT && new Date() > overdueTime) {
          await medicationReminderOccurrenceRepository.updateStatus(
            occurrence.id,
            reminderOccurrenceStatus.OVERDUE,
          );
          await reminderNotificationService.sendOverdueNotification(reminder);
          // console.log("updateReminder:==",updateReminder);
          // send notification
          await reminderNotificationService.sendReminderNotification(reminder);
          // console.log("reminder in cronService:==", reminder);

          await medicationReminderOccurrenceRepository.updateStatus(
            occurrence.id,
            reminderOccurrenceStatus.SENT,
            true,
            { notificationSentAt: new Date() },
          );

          console.log("Sent reminder:", occurrence.id);
        }
      } catch (err) {
        console.error("Reminder failed:", err);
      }
    }
  }
  // 2. SEND REFILL ALERTS REMINDERS
  async sendRefillAlert() {
    const medications = await medicationRepository.findMedicationsForRefillAlert(true);
    const seenMedicationIds = new Set();
    for (const medication of medications) {
      const refill = refillTime(medication.medication.endDate);
      const hour = refill.getHours();
      const minute = refill.getMinutes();

      if (now === hour && now === minute) {
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
}
module.exports = new ReminderService();
