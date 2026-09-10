const moment = require("moment-timezone");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const { env } = require("../configs/env");

const DAY_NAME_MAP = Object.freeze({
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
});

function matchesSpecificDays(momentDate, specificDays) {
  if (!Array.isArray(specificDays) || specificDays.length === 0) {
    return true;
  }
  const dayOfWeek = momentDate.day(); // 0 = Sunday, 1 = Monday, ..., 6 = Saturday
  const isoDay = momentDate.isoWeekday(); // 1 = Monday, ..., 7 = Sunday

  return specificDays.some((val) => {
    if (typeof val === "number") {
      return val === dayOfWeek || val === isoDay;
    }
    if (typeof val === "string") {
      const lower = val.toLowerCase().trim();
      const mapped = DAY_NAME_MAP[lower];
      if (mapped !== undefined) {
        return mapped === dayOfWeek;
      }
      const num = Number(lower);
      if (!isNaN(num)) {
        return num === dayOfWeek || num === isoDay;
      }
    }
    return false;
  });
}

function parseTime(t) {
  if (typeof t !== "string" || !t.includes(":")) {
    return { hours: 8, minutes: 0, seconds: 0 };
  }
  const [h, m, s = "0"] = t.split(":");
  return {
    hours: Number(h) || 0,
    minutes: Number(m) || 0,
    seconds: Number(s) || 0,
  };
}

function extractScheduleTimes(schedule = {}) {
  let timesList = [];
  if (schedule.Morning) timesList.push(schedule.Morning);
  if (schedule.Noon) timesList.push(schedule.Noon);
  if (schedule.Night) timesList.push(schedule.Night);
  if (Array.isArray(schedule.Custom)) {
    timesList.push(...schedule.Custom);
  }

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

  return (timesList || []).filter(Boolean);
}

function generateReminderOccurrences(reminder, medication, startFromDate = null, options = {}) {
  const occurrences = [];
  const schedule = medication.medicationSchedule || {};
  const times = extractScheduleTimes(schedule);

  if (times.length === 0) {
    return []; // Prevent infinite loop if no valid times are found
  }

  const userTimezone = medication.timezone || "Asia/Kolkata";
  const { skipPastOccurrences = true } = options;
  const now = new Date();

  // Normalize frequency and recurrence type
  const rawFrequency = (medication.frequency || "").toUpperCase().replace(/\s+/g, "_");
  const specificDays = schedule.specificDays || schedule.daysOfWeek || schedule.days || null;
  const isSpecificDays =
    rawFrequency === "SPECIFIC_DAYS" || (Array.isArray(specificDays) && specificDays.length > 0);

  const intervalDays = Math.max(
    1,
    Number(schedule.intervalDays || schedule.interval || medication.intervalDays || 1),
  );
  const isInterval = rawFrequency === "INTERVAL" || intervalDays > 1;

  // Initialize start calendar date in patient's timezone
  const startDateInput = startFromDate ? new Date(startFromDate) : new Date(medication.startDate);
  let localDate = moment.tz(startDateInput, userTimezone).startOf("day");

  const availableQuantity = Number(medication.remainingQuantity ?? medication.totalQuantity ?? 0);
  let consumedQuantity = 0;
  let daysProcessed = 0;
  let totalCalendarDaysChecked = 0;
  const MAX_ONGOING_DAYS = 30; // Cap at 30 days for ongoing medications to prevent runaway generation
  const MAX_CALENDAR_DAYS = 365; // Safety ceiling against infinite loops

  while (
    totalCalendarDaysChecked < MAX_CALENDAR_DAYS &&
    ((availableQuantity === 0 && daysProcessed < MAX_ONGOING_DAYS) ||
      (availableQuantity > 0 && consumedQuantity < availableQuantity))
  ) {
    totalCalendarDaysChecked++;

    // Check if the current calendar day matches specific days constraint
    if (isSpecificDays && !matchesSpecificDays(localDate, specificDays)) {
      localDate.add(1, "day");
      continue;
    }

    let dosesAddedToday = 0;

    for (const timeValue of times) {
      const dosePerIntake = Number(medication.dosePerIntake || 1);

      if (availableQuantity > 0 && consumedQuantity >= availableQuantity) {
        break;
      }

      const { hours, minutes, seconds } = parseTime(timeValue);

      // Construct timezone-anchored moment for this dose on this calendar date
      const localDateTime = localDate
        .clone()
        .hour(hours)
        .minute(minutes)
        .second(seconds)
        .millisecond(0);

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
      dosesAddedToday++;
    }

    if (availableQuantity > 0 && consumedQuantity >= availableQuantity) {
      break;
    }

    // Step to the next dose day
    const dayStep = isInterval ? intervalDays : 1;
    localDate.add(dayStep, "day");

    if (dosesAddedToday > 0 || !skipPastOccurrences) {
      daysProcessed++;
    } else if (localDate.isSameOrAfter(moment.tz(now, userTimezone).startOf("day"))) {
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
  const afterMinutes = env.afterReminderNotificationMinutes || env.reminderAfterMinutes || 15;
  return new Date(actualMedicationTime.getTime() + afterMinutes * 60 * 1000);
}

function convertToUserTimeZone(utcDate, targetTimezone = "Asia/Kolkata") {
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
  convertToUserTimeZone,
  matchesSpecificDays,
  parseTime,
  extractScheduleTimes,
};
