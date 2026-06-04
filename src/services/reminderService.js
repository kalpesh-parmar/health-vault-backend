// repositories/services
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const medicationRepository = require("../repositories/medicationRepository");
const { beforeReminderTime, afterReminderTime } = require("../utils/reminderOccurrenceGenerator");
const { env } = require("../configs/env");
class ReminderService {
  constructor() {
    this.refillReminderFlag = true;
  }
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
      // console.log("reminder payload:==", reminder);
      try {
        const { occurrence, medication } = reminder;
        const now = new Date();
        const beforeTime = beforeReminderTime(
          occurrence.actualMedicationTime,
          medication.reminderBeforeMinutes,
        );
        // console.log("beforeTime==",beforeTime);
        const afterTime = afterReminderTime(
          occurrence.actualMedicationTime,
          env.reminderAfterMinutes,
        );

        // 1. Send Main Reminder Notification
        if (!occurrence.notificationSent && now >= beforeTime) {
          // await reminderNotificationService.sendReminderNotification(
          //   reminder,
          //   reminderTypes.BEFORE,
          // );
          this.refillReminderFlag = true;
          console.log("Sent Before reminder notification for occurrence:", occurrence.id);
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
          // !occurrence.afterNotificationSent &&
          occurrence.status == reminderOccurrenceStatus.PENDING &&
          now >= new Date(afterTime)
        ) {
          // await reminderNotificationService.sendReminderNotification(reminder, reminderTypes.AFTER);
          console.log("Sent notification after medication time for occurrence:", occurrence.id);
        }

        //3. send follow up notification if 30 mins over due and not marked as skipped
        if (
          // occurrence.afterNotificationSent &&
          !occurrence.overdueNotificationSent &&
          occurrence.status === reminderOccurrenceStatus.PENDING &&
          now >= new Date(afterTime.getTime() + 30 * 60 * 1000)
        ) {
          // await reminderNotificationService.sendOverdueNotification(reminder);
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

    const now = new Date();

    const hour = now.getHours();
    const minute = now.getMinutes();

    const isReminderTime =
      (hour === 10 && minute === 0) || // 10:00 AM
      (hour === 19 && minute === 0); // 7:00 PM

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
        // await reminderNotificationService.sendReminderNotification(
        //   medication,
        //   reminderTypes.REFILL,
        // );
        await medicationReminderOccurrenceRepository.clearRefillReminderTime(medicationId);
        console.log(`Refill alert sent for medication ${medicationId}`);
      } catch (err) {
        console.error(`Refill alert failed for medication ${medicationId}`, err);
      }
    }
  }
}
module.exports = new ReminderService();
