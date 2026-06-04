const moment = require("moment-timezone");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");

function generateReminderOccurrences(reminder, medication, startFromDate = null) {
  const occurrences = [];
  const medicationTimes = medication.medicationTime || [];
  const userTimezone = medication.timezone || "Asia/Kolkata";
  const currentDate = startFromDate ? new Date(startFromDate) : new Date(medication.startDate);
  currentDate.setUTCHours(0, 0, 0, 0);

  const endDate = calculateMedicationEndDate(medication);

  let consumedQuantity = 0;

  while (currentDate <= endDate) {
    for (const timeObj of medicationTimes) {
      const dosePerIntake = Number(medication.dosePerIntake || 1);

      const totalQuantity = Number(medication.totalQuantity || 0);

      // Stop generation when quantity is exhausted
      if (totalQuantity > 0 && consumedQuantity + dosePerIntake > totalQuantity) {
        return occurrences;
      }

      let [hours, minutes] = timeObj.time.split(":").map(Number);

      const period = timeObj.period.toUpperCase();

      // Convert AM/PM to 24-hour format
      if (period === "PM" && hours !== 12) {
        hours += 12;
      }

      if (period === "AM" && hours === 12) {
        hours = 0;
      }

      const localDateTime = moment.tz(
        {
          year: currentDate.getUTCFullYear(),
          month: currentDate.getUTCMonth(),
          date: currentDate.getUTCDate(),
          hour: hours,
          minute: minutes,
          second: 0,
        },
        userTimezone,
      );

      const actualMedicationTime = localDateTime.clone().utc().toDate();

      const beforeReminderTime = new Date(
        actualMedicationTime.getTime() - reminder.reminderBeforeMinutes * 60000,
      );
      const afterReminderTime = new Date(
        actualMedicationTime.getTime() + reminder.afterReminderMinutes * 60000,
      );

      const refillReminderTime = reminder.refillAlertBeforeDays
        ? new Date(endDate.getTime() - reminder.refillAlertBeforeDays * 24 * 60 * 60000)
        : null;
      occurrences.push({
        reminderId: reminder.id,
        medicationId: medication.id,
        patientId: medication.userId,
        status: reminderOccurrenceStatus.PENDING,
        actualMedicationTime,
        beforeReminderTime,
        afterReminderTime,
        refillReminderTime,
        notificationSent: false,
        notificationSentAt: null,
        completedAt: null,
        isOverdue: false,
        softDelete: false,
      });
      consumedQuantity += dosePerIntake;
    }

    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }

  return occurrences;
}

function calculateMedicationEndDate(medication) {
  if (medication.endDate) {
    const end = new Date(medication.endDate);

    end.setUTCHours(23, 59, 59, 999);

    return end;
  }

  const startDate = new Date(medication.startDate);

  startDate.setUTCHours(0, 0, 0, 0);

  const medicationTimes = medication.medicationTime || [];

  const dailyConsumption = medicationTimes.length * Number(medication.dosePerIntake || 1);

  const totalDays =
    dailyConsumption > 0 ? Math.floor(Number(medication.totalQuantity || 0) / dailyConsumption) : 0;

  const calculatedEndDate = new Date(startDate);

  calculatedEndDate.setUTCDate(calculatedEndDate.getUTCDate() + totalDays);

  calculatedEndDate.setUTCHours(23, 59, 59, 999);

  return calculatedEndDate;
}
function beforeReminderTime(actualTime, reminderBeforeMinutes) {
  return new Date(actualTime.getTime() - reminderBeforeMinutes * 60000);
}

function afterReminderTime(actualTime, afterReminderMinutes) {
  return new Date(actualTime.getTime() + afterReminderMinutes * 60000);
}

function convertToISTTime(date) {
  return new Date(date).toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  });
}

module.exports = {
  generateReminderOccurrences,
  beforeReminderTime,
  afterReminderTime,
  convertToISTTime,
};
