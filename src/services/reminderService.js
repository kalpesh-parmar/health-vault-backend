// repositories/services
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const reminderNotificationService = require("./reminderNotificationService");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
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
}
module.exports = new ReminderService();
