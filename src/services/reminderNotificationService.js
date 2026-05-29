// const { notificationType } = require("../enums/notificationType");
const { reminderType } = require("../enums/reminderType");
const notificationService = require("./notificationService");

class ReminderNotificationService {
  // MAIN SEND NOTIFICATION
  async sendReminderNotification(occurrence) {
    try {
      let payload = null;

      switch (occurrence.occurrence.type) {
        // BEFORE MEDICATION
        case reminderType.BEFORE_MEDICATION:
          payload = this.sendBeforeMedicationReminder(occurrence);
          break;
        // AFTER MEDICATION
        case reminderType.AFTER_MEDICATION:
          payload = this.sendAfterMedicationReminder(occurrence);
          break;
        // REFILL ALERT
        case reminderType.REFILL_ALERT:
          payload = this.sendRefillAlertReminder(occurrence);
          break;

        default:
          console.log(" Unknown reminder type");
      }
      await notificationService.sendToUser(occurrence.patientId, payload);
    } catch (error) {
      console.error(" sendReminderNotification error:", error);
    }
  }
  // BEFORE MEDICATION REMINDER
  sendBeforeMedicationReminder(occurrence) {
    console.log(" BEFORE MEDICATION REMINDER");
    return {
      occurrenceId: occurrence.occurrence.id,
      title: "Medication Reminder",
      body: "Your medication time is coming soon.",
      data: {
        type: reminderType.BEFORE_MEDICATION,
      },
    };
  }

  // AFTER MEDICATION REMINDER
  sendAfterMedicationReminder(occurrence) {
    console.log(" AFTER MEDICATION REMINDER");
    return {
      occurrenceId: occurrence.occurrence.id,
      title: "Did you take your medicine?",
      body: "Please confirm your medication status.",
      data: {
        type: reminderType.AFTER_MEDICATION,
        // actions: ["COMPLETE", "MISSED", "SKIPPED", "SNOOZE"],
      },
    };
  }
  // REFILL ALERT REMINDER

  sendRefillAlertReminder(occurrence) {
    console.log(" REFILL ALERT REMINDER");
    return {
      occurrenceId: occurrence.occurrence.id,
      title: "Medication Refill Alert",
      body: "Your medication stock may finish soon.",
      data: {
        type: reminderType.REFILL_ALERT,
      },
    };
  }

  async sendOverdueNotification(occurrence) {
    try {
      console.log(" OVERDUE REMINDER");
      const payload = {
        occurrenceId: occurrence.occurrence.id,
        title: "Medication Overdue",
        body: "You missed your medication time.",
        data: {
          type: "OVERDUE_REMINDER",
          // medicationId: occurrence.occurrence.medicationId,
          // occurrenceId: occurrence.occurrence.id,
          // actions: ["COMPLETE", "SKIP"],
        },
      };
      await notificationService.sendToUser(occurrence.patientId, payload);
    } catch (error) {
      console.error(" sendOverdueNotification error:", error);
    }
  }
}

module.exports = new ReminderNotificationService();
