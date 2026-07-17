const moment = require("moment-timezone");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const { env } = require("../configs/env");

function generateReminderOccurrences(reminder, medication, startFromDate = null, options = {}) {
  const occurrences = [];

  // Extract times safely supporting both formats
  let timesList = [];
  const schedule = medication.medicationSchedule || {};
  // 1. Check for the new schema fields
  if (schedule.Morning) timesList.push(schedule.Morning);
  if (schedule.Noon) timesList.push(schedule.Noon);
  if (schedule.Night) timesList.push(schedule.Night);
  if (Array.isArray(schedule.Custom)) {
    timesList.push(...schedule.Custom);
  }

  // 2. Fallback to legacy checks if it's an old medication
  if (timesList.length === 0) {
    if (Array.isArray(schedule.times)) {
      timesList = schedule.times;
    } else if (Array.isArray(schedule.reminderTimes)) {
      timesList = schedule.reminderTimes;
    } else {
      timesList = Object.keys(schedule).filter(
        (key) => typeof key === "string" && key.includes(":"),
      );
    }
  }

  // if (Array.isArray(schedule.times)) {
  //   timesList = schedule.times;
  // } else if (Array.isArray(schedule.reminderTimes)) {
  //   timesList = schedule.reminderTimes;
  // } else {
  //   // Legacy mapping (flat object with time keys/values)
  //   timesList = Object.keys(schedule).filter((key) => typeof key === "string" && key.includes(":"));
  // }

  // Defensively filter and parse each time
  const parseTime = (t) => {
    if (typeof t !== "string" || !t.includes(":")) {
      return { hours: 8, minutes: 0, seconds: 0 };
    }
    const [h, m, s = "0"] = t.split(":");
    return {
      hours: Number(h) || 0,
      minutes: Number(m) || 0,
      seconds: Number(s) || 0,
    };
  };

  const times = (timesList || []).filter(Boolean);
  if (times.length === 0) {
    return []; // Prevent infinite loop if no valid times are found
  }

  const userTimezone = medication.timezone || "Asia/Kolkata";
  const { skipPastOccurrences = true } = options;
  const now = new Date();
  const currentDate = startFromDate ? new Date(startFromDate) : new Date(medication.startDate);
  const availableQuantity = Number(medication.remainingQuantity ?? medication.totalQuantity ?? 0);
  let consumedQuantity = 0;
  let daysProcessed = 0;
  const MAX_ONGOING_DAYS = 30; // Cap at 30 days for ongoing medications to prevent infinite loop

  while (
    (availableQuantity === 0 && daysProcessed < MAX_ONGOING_DAYS) ||
    (availableQuantity > 0 && consumedQuantity < availableQuantity)
  ) {
    for (const timeValue of times) {
      const dosePerIntake = Number(medication.dosePerIntake || 1);

      if (availableQuantity > 0 && consumedQuantity >= availableQuantity) {
        break;
      }
      const { hours, minutes, seconds } = parseTime(timeValue);

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

    // Only increment daysProcessed if we have passed the start date (to ensure we generate enough future days)
    if (currentDate >= now) {
      daysProcessed++;
    } else if (!skipPastOccurrences) {
      daysProcessed++;
    }
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
