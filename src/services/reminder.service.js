// repositories/services
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const medicationRepository = require("../repositories/medicationRepository");
const refillRepository = require("../repositories/refillRepository");
const notificationRepository = require("../repositories/notificationRepository");
const { calculateRemainingQuantity } = require("../utils/remainingQuantityCalculation");
const { beforeReminderTime, afterReminderTime } = require("../utils/reminderOccurrenceGenerator");
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
    const now = new Date();
    // Bounded time window: occurrences scheduled from 3 hours ago to 2 hours in the future
    const startTime = new Date(now.getTime() - 3 * 60 * 60 * 1000);
    const endTime = new Date(now.getTime() + 2 * 60 * 60 * 1000);

    const reminders = await medicationReminderOccurrenceRepository.findPendingReminders(
      [reminderOccurrenceStatus.PENDING],
      { startTime, endTime },
    );

    for (const reminder of reminders) {
      try {
        const { occurrence, medication } = reminder;
        const actualMedTime = new Date(occurrence.actualMedicationTime);
        const beforeTime = beforeReminderTime(actualMedTime, medication.reminderBeforeMinutes || 5);
        const afterTime = afterReminderTime(actualMedTime);
        const overdueTime = new Date(afterTime.getTime() + 30 * 60 * 1000);

        // 1. Send Main Reminder Notification (Before intake time)
        if (beforeTime && now >= beforeTime && now < actualMedTime) {
          const alreadySent = await notificationRepository.findReminderNotificationSent(
            medication.userId,
            occurrence.id,
            reminderTypes.BEFORE,
          );
          if (!alreadySent) {
            await reminderNotificationService.sendReminderNotification(
              reminder,
              reminderTypes.BEFORE,
            );
          }
        }

        // 2. Mark overdue once actual medication time has passed
        if (
          !occurrence.isOverdue &&
          now >= actualMedTime &&
          occurrence.status === reminderOccurrenceStatus.PENDING
        ) {
          await medicationReminderOccurrenceRepository.update(occurrence.id, {
            isOverdue: true,
          });
          occurrence.isOverdue = true;
        }

        // 3. Send after Notification
        const afterWindowEnd = new Date(afterTime.getTime() + 15 * 60 * 1000);
        if (
          occurrence.isOverdue &&
          occurrence.status === reminderOccurrenceStatus.PENDING &&
          now >= afterTime &&
          now <= afterWindowEnd
        ) {
          const alreadySent = await notificationRepository.findReminderNotificationSent(
            medication.userId,
            occurrence.id,
            reminderTypes.AFTER,
          );
          if (!alreadySent) {
            await reminderNotificationService.sendReminderNotification(
              reminder,
              reminderTypes.AFTER,
            );
          }
        }

        // 4. Send follow up notification if 30 mins overdue
        const overdueWindowEnd = new Date(overdueTime.getTime() + 15 * 60 * 1000);
        if (
          occurrence.isOverdue &&
          occurrence.status === reminderOccurrenceStatus.PENDING &&
          now >= overdueTime &&
          now <= overdueWindowEnd
        ) {
          const alreadySent = await notificationRepository.findReminderNotificationSent(
            medication.userId,
            occurrence.id,
            "OVERDUE",
          );
          if (!alreadySent) {
            await reminderNotificationService.sendOverdueNotification(reminder);
          }
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
