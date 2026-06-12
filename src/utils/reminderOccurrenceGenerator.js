const moment = require("moment-timezone");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const { env } = require("../configs/env");

function generateReminderOccurrences(reminder, medication, startFromDate = null, options = {}) {
  const occurrences = [];
  const medicationTimes = Object.entries(medication.medicationSchedule || {});
  const userTimezone = medication.timezone || "Asia/Kolkata";
  const { skipPastOccurrences = true } = options;
  const now = new Date();
  const currentDate = startFromDate ? new Date(startFromDate) : new Date(medication.startDate);
  const availableQuantity = Number(medication.remainingQuantity ?? medication.totalQuantity ?? 0);
  let consumedQuantity = 0;

  while (availableQuantity === 0 || consumedQuantity < availableQuantity) {
    for (const [, timeValue] of medicationTimes) {
      const dosePerIntake = Number(medication.dosePerIntake || 1);

      if (availableQuantity > 0 && consumedQuantity >= availableQuantity) {
        break;
      }
      const [hours, minutes, seconds = 0] = timeValue.split(":").map(Number);

      const localDateTime = moment.tz(
        {
          year: currentDate.getUTCFullYear(),
          month: currentDate.getUTCMonth(),
          date: currentDate.getUTCDate(),
          hour: hours,
          minute: minutes,
          second: seconds,
        },
        userTimezone,
      );
      const actualMedicationTime = localDateTime.clone().utc().toDate();
      if (skipPastOccurrences && actualMedicationTime < now) {
        continue;
      }
      occurrences.push({
        reminderId: reminder.id,
        medicationId: medication.id,
        patientId: medication.userId,
        status: reminderOccurrenceStatus.PENDING,
        actualMedicationTime,
        completedAt: null,
        isOverdue: false,
        softDelete: false,
      });
      consumedQuantity += dosePerIntake;
    }

    if (availableQuantity > 0 && consumedQuantity >= availableQuantity) {
      break;
    }
    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }
  return occurrences;
}
function beforeReminderTime(actualMedicationTime, reminderBeforeMinutes) {
  if (!reminderBeforeMinutes) {
    return null;
  }
  return new Date(actualMedicationTime.getTime() - reminderBeforeMinutes * 60 * 1000);
}
function isSameMinute(time1, time2) {
  if (!time1 || !time2) {
    return false;
  }
  return (
    time1.getMinutes() === time2.getMinutes() &&
    time1.getHours() === time2.getHours() &&
    time1.getDate() === time2.getDate() &&
    time1.getMonth() === time2.getMonth() &&
    time1.getFullYear() === time2.getFullYear()
  );
}
function afterReminderTime(actualMedicationTime) {
  return new Date(
    actualMedicationTime.getTime() + env.afterReminderNotificationMinutes * 60 * 1000,
  );
}
// function convertToISTTime(actualMedicationTime) {
//   const istTime = moment(actualMedicationTime).tz("Asia/Kolkata");
//   return istTime.format("HH:mm");
// }
function convertToUserTimeZone(utcDate) {
  const targetTimezone = "Asia/Kolkata";
  if (!utcDate) {
    return null;
  }
  return moment(utcDate).tz(targetTimezone).format("hh:mm A");
}
module.exports = {
  generateReminderOccurrences,
  beforeReminderTime,
  afterReminderTime,
  isSameMinute,
  // convertToISTTime,
  convertToUserTimeZone,
};
