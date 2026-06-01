const { notificationType } = require("../enums/notificationType");
const { reminderTypes } = require("../enums/reminderTypes");
const notificationService = require("./notificationService");

class ReminderNotificationService {
  // MAIN SEND NOTIFICATION
  async sendReminderNotification(occurrence, type) {
    try {
      let payload = null;

      if (type === reminderTypes.BEFORE) {
        payload = this.sendBeforeMedicationReminder(occurrence);
      } else if (type === reminderTypes.AFTER) {
        payload = this.sendAfterMedicationReminder(occurrence);
      } else if (type === reminderTypes.REFILL) {
        payload = this.sendRefillAlertReminder(occurrence);
      } else {
        console.log(" Unknown reminder type");
        return;
      }
      await notificationService.sendToUser(occurrence.patientId || occurrence.userId, payload);
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
        type: notificationType.MEDICATION_REMINDER,
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
        type: notificationType.MEDICATION_REMINDER,
      },
    };
  }
  // REFILL ALERT REMINDER

  sendRefillAlertReminder(occurrence) {
    console.log(" REFILL ALERT REMINDER");
    return {
      medicationId: occurrence.occurrence.id,
      title: "Medication Refill Alert",
      body: "Your medication stock may finish soon.",
      data: {
        type: notificationType.REFILL_ALERT,
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
          type: notificationType.OVERDUE_REMINDER,
        },
      };
      await notificationService.sendToUser(occurrence.patientId, payload);
    } catch (error) {
      console.error(" sendOverdueNotification error:", error);
    }
  }
}

module.exports = new ReminderNotificationService();
