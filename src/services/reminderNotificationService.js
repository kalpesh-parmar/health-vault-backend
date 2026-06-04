const { notificationType } = require("../enums/notificationType");
const Mustache = require("mustache");
const { reminderTypes } = require("../enums/reminderTypes");
const notificationService = require("./notificationService");
const { convertToISTTime } = require("../utils/reminderOccurrenceGenerator");

class ReminderNotificationService {
  ReminderNotificationService(data) {
    return {
      medicine_time: data.occurrence.actualMedicationTime.toISOString(),
      medicineName: data.medication.medicationName,
      localTime: convertToISTTime(data.occurrence.actualMedicationTime),
    };
  }
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
      await notificationService.sendToUser(occurrence.medication.userId, payload);
    } catch (error) {
      console.error(" sendReminderNotification error:", error);
    }
  }

  // BEFORE MEDICATION REMINDER
  sendBeforeMedicationReminder(data) {
    console.log(" BEFORE MEDICATION REMINDER");
    const variable = this.ReminderNotificationService(data);
    const template = "Upcoming dose {{medicineName}}. Be ready at {{localTime}}!";
    return {
      // occurrenceId: occurrence.occurrence.id,
      title: "Medication Reminder",
      body: Mustache.render(template, variable),
      data: {
        type: notificationType.BEFORE_MEDICATION_REMINDER,
        ...variable,
      },
    };
  }

  // AFTER MEDICATION REMINDER
  sendAfterMedicationReminder(data) {
    console.log(" AFTER MEDICATION REMINDER");
    const variable = this.ReminderNotificationService(data);
    const template = `Did you take your {{medicineName}} at {{localTime}}?`;
    return {
      // occurrenceId: occurrence.occurrence.id,
      title: "Medication Check-In",
      body: Mustache.render(template, variable),
      data: {
        type: notificationType.AFTER_MEDICATION_REMINDER,
        ...variable,
      },
    };
  }
  // REFILL ALERT REMINDER

  sendRefillAlertReminder(data) {
    // console.log("occurrence:==", data);
    console.log(" REFILL ALERT REMINDER");
    const variable = this.ReminderNotificationService(data);
    const template = "{{medicineName}} may be running low. Consider refilling soon.";
    return {
      // medicationId: occurrence.medication.id,
      title: "Refill Reminder",
      body: Mustache.render(template, variable),
      data: {
        type: notificationType.REFILL_ALERT,
        ...variable,
      },
    };
  }

  async sendOverdueNotification(occurrence) {
    try {
      console.log(" OVERDUE REMINDER");
      const variable = this.ReminderNotificationService(occurrence);
      const template = `You may have missed your {{medicineName}} dose at {{localTime}}`;
      let payload = {
        title: "Medication Overdue",
        body: Mustache.render(template, variable),
        data: {
          type: notificationType.FOLLOW_UP_MEDICATION_REMINDER,
          ...variable,
        },
      };

      await notificationService.sendToUser(occurrence.medication.userId, payload);
    } catch (error) {
      console.error(" sendOverdueNotification error:", error);
    }
  }
}

module.exports = new ReminderNotificationService();
