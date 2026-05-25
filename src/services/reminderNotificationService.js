const { reminderType } = require("../enums/reminderType");
const notificationService = require("./notificationService");

class ReminderNotificationService {
  // MAIN SEND NOTIFICATION
  async sendReminderNotification(occurrence) {
    try {
      let payload = null;
      switch (occurrence.type) {
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
          console.log("❌ Unknown reminder type");
      }
      await notificationService.sendToUser(occurrence.userId, payload);
    } catch (error) {
      console.error("❌ sendReminderNotification error:", error);
    }
  }
  // BEFORE MEDICATION REMINDER
  sendBeforeMedicationReminder(occurrence) {
    console.log("💊 BEFORE MEDICATION REMINDER");
    return {
      occurrenceId: occurrence.id,
      title: "Medication Reminder",
      body: "Your medication time is coming soon.",
      data: {
        type: reminderType.BEFORE_MEDICATION,
        scheduledAt: occurrence.scheduledAt,
      },
    };
  }

  // AFTER MEDICATION REMINDER
  sendAfterMedicationReminder(occurrence) {
    console.log("💊 AFTER MEDICATION REMINDER");
    return {
      occurrenceId: occurrence.id,
      title: "Did you take your medication?",
      body: "Please confirm your medication status.",
      data: {
        type: reminderType.AFTER_MEDICATION,
        actions: ["COMPLETE", "MISSED", "SKIPPED", "SNOOZE"],
        scheduledAt: occurrence.scheduledAt,
      },
    };
  }

  // REFILL ALERT REMINDER

  sendRefillAlertReminder(occurrence) {
    console.log("💊 REFILL ALERT REMINDER");

    return {
      occurrenceId: occurrence.id,
      title: "Medication Refill Alert",
      body: "Your medication stock may finish soon.",
      data: {
        type: reminderType.REFILL_ALERT,
        scheduledAt: occurrence.scheduledAt,
      },
    };
  }

  //
  // SEND PUSH NOTIFICATION
  //
  async sendPushNotification(userId, notificationData) {
    try {
      //
      // TODO:
      // FIREBASE FCM LOGIC
      //

      console.log("📲 Push notification sent");

      console.log({
        userId,

        notificationData,
      });

      return true;
    } catch (error) {
      console.error("❌ Push notification error:", error);

      return false;
    }
  }

  //
  // SEND SOCKET EVENT
  //
  async sendSocketEvent(userId, event, payload) {
    try {
      //
      // TODO:
      // SOCKET.IO LOGIC
      //

      console.log("🔌 Socket event sent");

      console.log({
        userId,
        event,
        payload,
      });

      return true;
    } catch (error) {
      console.error("❌ Socket event error:", error);

      return false;
    }
  }
}

module.exports = new ReminderNotificationService();
