const { reminderType } = require("../enums/reminderType");

class ReminderNotificationService {
  
  // MAIN SEND NOTIFICATION
  async sendReminderNotification(occurrence) {
    try {
      switch (occurrence.type) {
      
        // BEFORE MEDICATION
        case reminderType.BEFORE_MEDICATION:
          await this.sendBeforeMedicationReminder(occurrence);
          break;
        // AFTER MEDICATION
        case reminderType.AFTER_MEDICATION:
          await this.sendAfterMedicationReminder(occurrence);
          break;
        // REFILL ALERT
        case reminderType.REFILL_ALERT:
          await this.sendRefillAlertReminder(occurrence);
          break;

        default:
          console.log("❌ Unknown reminder type");
      }
    } catch (error) {
      console.error("❌ sendReminderNotification error:", error);
    }
  }
  // BEFORE MEDICATION REMINDER
  async sendBeforeMedicationReminder(occurrence) {
    //
    // TODO:
    // FIREBASE PUSH NOTIFICATION
    // SOCKET EVENT
    // EMAIL
    // SMS
    //

    console.log("💊 BEFORE MEDICATION REMINDER");

    console.log({
      occurrenceId: occurrence.id,
      title: "Medication Reminder",
      body: "Your medication time is coming soon.",
      type: reminderType.BEFORE_MEDICATION,
      scheduledAt: occurrence.scheduledAt,
    });
  }

  // AFTER MEDICATION REMINDER
  async sendAfterMedicationReminder(occurrence) {
    //
    // USER ACTIONS:
    // COMPLETE
    // MISSED
    // SKIPPED
    // SNOOZE
    //

    console.log("💊 AFTER MEDICATION REMINDER");

    console.log({
      occurrenceId: occurrence.id,
      title: "Did you take your medication?",
      body: "Please confirm your medication status.",
      type: reminderType.AFTER_MEDICATION,
      actions: ["COMPLETE", "MISSED", "SKIPPED", "SNOOZE"],
      scheduledAt: occurrence.scheduledAt,
    });
  }
  
  // REFILL ALERT REMINDER

  async sendRefillAlertReminder(occurrence) {
    console.log("💊 REFILL ALERT REMINDER");

    console.log({
      occurrenceId: occurrence.id,

      title: "Medication Refill Alert",

      body: "Your medication stock may finish soon.",

      type: reminderType.REFILL_ALERT,

      scheduledAt: occurrence.scheduledAt,
    });
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
