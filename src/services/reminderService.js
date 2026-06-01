// repositories/services
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const reminderNotificationService = require("./reminderNotificationService");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const medicationRepository = require("../repositories/medicationRepository");
const { reminderTypes } = require("../enums/reminderTypes");
class ReminderService {
  // 1. SEND REMINDERS (EVERY MINUTE)
  async sendReminder() {
    const reminders = await medicationReminderOccurrenceRepository.findPendingReminders([
      reminderOccurrenceStatus.PENDING,
    ]);

    for (const reminder of reminders) {
      try {
        const { occurrence } = reminder;
        const now = new Date();
        ("");

        // 1. Send Main Reminder Notification
        if (!occurrence.notificationSent && now >= new Date(occurrence.beforeReminderTime)) {
          await reminderNotificationService.sendReminderNotification(
            reminder,
            reminderTypes.BEFORE,
          );
          await medicationReminderOccurrenceRepository.update(occurrence.id, {
            notificationSent: true,
            notificationSentAt: now,
          });
          console.log("Sent main reminder notification for occurrence:", occurrence.id);
        }
        //MARK AS FOLLOW UP TRUE AFTER ACTUAL MEDICATION TIME
        if (
          now >= new Date(occurrence.actualMedicationTime) &&
          occurrence.status == reminderOccurrenceStatus.PENDING
        ) {
          await medicationReminderOccurrenceRepository.update(occurrence.id, {
            isOverdue: true,
          });
          console.log("Marked as follow up for occurrence:", occurrence.id);
        }

        // 2. Send after Notification
        if (
          occurrence.isOverdue &&
          occurrence.status == reminderOccurrenceStatus.PENDING &&
          now >= new Date(occurrence.afterReminderTime)
        ) {
          await reminderNotificationService.sendReminderNotification(reminder, reminderTypes.AFTER);
          await medicationReminderOccurrenceRepository.update(occurrence.id, {
            afterNotificationSent: true,
            afterNotificationSentAt: now,
          });
          console.log("Sent notification after medication time for occurrence:", occurrence.id);
        }

        //3. send follow up notification if 30 mins over due and not marked as skipped
        if (
          occurrence.afterNotificationSent &&
          // !occurrence.followUpNotificationSent &&
          occurrence.status === reminderOccurrenceStatus.PENDING &&
          now >= new Date(new Date(occurrence.afterNotificationSentAt).getTime() + 30 * 60 * 1000)
        ) {
          await reminderNotificationService.sendOverdueNotification(reminder);
          await medicationReminderOccurrenceRepository.update(occurrence.id, {
            overdueNoificationSent: true,
            overdueNotificationSentAt: now,
          });
          console.log("sent Followup notification to occurence:", occurrence.id);
        }
      } catch (err) {
        console.error("Reminder failed:", err);
      }
    }
  }
  // 2. SEND REFILL ALERTS REMINDERS
  async sendRefillAlert() {
    const medications = await medicationRepository.findMedicationsForRefillAlert(true);
    console.log("medications:=", medications.length);

    const now = new Date();

    for (const medication of medications) {
      try {
        const beforeDays = medication.refillAlertBeforeDays || 2;

        const alertDate = new Date(medication.endDate);

        alertDate.setDate(alertDate.getDate() - beforeDays);
        // console.log("payload:",medication);

        if (now >= alertDate && medication.dailyConsumption >= medication.totalQuantity) {
          // await reminderNotificationService.sendReminderNotification(medication, reminderTypes.REFILL);

          console.log(`Refill alert sent for medication ${medication.id}`);
        }
      } catch (err) {
        console.error(`Refill alert failed for medication ${medication.id}`, err);
      }
    }
  }
}
module.exports = new ReminderService();
