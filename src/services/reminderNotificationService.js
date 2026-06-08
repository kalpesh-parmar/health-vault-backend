const { notificationType } = require("../enums/notificationType");
const Mustache = require("mustache");
const { reminderTypes } = require("../enums/reminderTypes");
const notificationService = require("./notificationService");
const { convertToISTTime } = require("../utils/reminderOccurrenceGenerator");
const { notificationConstant } = require("../constants/notificationConstants");

class ReminderNotificationService {
  ReminderNotificationService(data) {
    const actualTime = data?.occurrence?.actualMedicationTime;

    return {
      medicineName: data.medication.medicationName,
      ...(actualTime && {
        medicineTime: actualTime.toISOString(),
        localTime: convertToISTTime(actualTime),
      }),
    };
  }
  //  SEND NOTIFICATION
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
    return {
      title: notificationConstant.BEFORE_REMINDER,
      body: Mustache.render(notificationConstant.BEFORE_MEDICATION_TEMPLATE, variable),
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
    return {
      title: notificationConstant.AFTER_REMINDER,
      body: Mustache.render(notificationConstant.AFTER_MEDICATION_TEMPLATE, variable),
      data: {
        type: notificationType.AFTER_MEDICATION_REMINDER,
        ...variable,
      },
    };
  }
  // REFILL ALERT REMINDER

  sendRefillAlertReminder(data) {
    console.log(" REFILL ALERT REMINDER");
    const variable = this.ReminderNotificationService(data);
    return {
      title: notificationConstant.REFILL_REMINDER,
      body: Mustache.render(notificationConstant.REFILL_ALERT_TEMPLATE, variable),
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
      let payload = {
        title: notificationConstant.FOLLOW_UP_REMINDER,
        body: Mustache.render(notificationConstant.FOLLOW_UP_TEMPLATE, variable),
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
