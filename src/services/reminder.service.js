// repositories/services
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const medicationRepository = require("../repositories/medicationRepository");
const refillRepository = require("../repositories/refillRepository");
const notificationRepository = require("../repositories/notificationRepository");
const { calculateRemainingQuantity } = require("../utils/remainingQuantityCalculation");
const {
  beforeReminderTime,
  afterReminderTime,
  isSameMinute,
} = require("../utils/reminderOccurrenceGenerator");
const reminderNotificationService = require("./reminderNotification.service");
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
    try {
      const medications = await medicationRepository.findAllActive(true);
      for (const medication of medications) {
        try {
          // 1. Calculate remaining quantity dynamically
          const remainingQuantity = await calculateRemainingQuantity(medication);

          // 2. Check if dailyConsumption >= remainingQuantity
          if (medication.dailyConsumption >= remainingQuantity) {
            // 3. Find the latest refill time or medication creation time
            const latestRefill = await refillRepository.findLatestRefillByMedicationId(
              medication.id,
            );
            const lastRefillTime = latestRefill ? latestRefill.createdAt : medication.createdAt;

            // 4. Check if we have already sent a refill alert notification since lastRefillTime
            const alreadySent = await notificationRepository.findRefillAlertSentSince(
              medication.userId,
              medication.id,
              lastRefillTime,
            );
            if (!alreadySent) {
              //5. Send notification
              await reminderNotificationService.sendReminderNotification(
                { medication },
                reminderTypes.REFILL,
              );
              console.log("Condition value", medication.id, !alreadySent);
            }
          }
        } catch (medErr) {
          console.error(`Refill alert check failed for medication ${medication.id}:`, medErr);
        }
      }
    } catch (err) {
      console.error("sendRefillAlert failed:", err);
    }
  }
}
module.exports = new ReminderService();
