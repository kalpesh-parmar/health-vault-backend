const moment = require("moment-timezone");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
const { env } = require("../configs/env");

function generateReminderOccurrences(reminder, medication, startFromDate = null, options = {}) {
  const occurrences = [];
  const medicationTimes = medication.medicationTime || [];
  const userTimezone = medication.timezone || "Asia/Kolkata";
  const { skipPastOccurrences = true } = options;

  const now = new Date();
  const currentDate = startFromDate ? new Date(startFromDate) : new Date(medication.startDate);
  currentDate.setUTCHours(0, 0, 0, 0);
  const endDate = calculateMedicationEndDate(medication);
  const availableQuantity = Number(medication.remainingQuantity ?? medication.totalQuantity ?? 0);
  let consumedQuantity = 0;

  while (availableQuantity === 0 || consumedQuantity < availableQuantity) {
    for (const timeObj of medicationTimes) {
      const dosePerIntake = Number(medication.dosePerIntake || 1);

      if (availableQuantity > 0 && consumedQuantity >= availableQuantity) {
        break;
      }

      let [hours, minutes] = timeObj.time.split(":").map(Number);

      const period = timeObj.period.toUpperCase();

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
      if (startFromDate && actualMedicationTime <= new Date(startFromDate)) {
        continue;
      }
      if (skipPastOccurrences && actualMedicationTime < now) {
        continue;
      }

      occurrences.push({
        reminderId: reminder.id,
        medicationId: medication.id,
        patientId: medication.userId,
        status: reminderOccurrenceStatus.PENDING,
        actualMedicationTime,
        beforeReminderTime: beforeReminderTime(
          actualMedicationTime,
          reminder.beforeReminderMinutes,
        ),
        afterReminderTime: afterReminderTime(actualMedicationTime),
        refillReminderTime: refillTime(endDate),
        notificationSent: false,
        notificationSentAt: null,
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

  if (occurrences.length > 0) {
    const finalEndDate = occurrences[occurrences.length - 1].actualMedicationTime;
    const finalRefillTime = refillTime(finalEndDate);
    for (const occurrence of occurrences) {
      occurrence.refillReminderTime = finalRefillTime;
    }
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
    dailyConsumption > 0 ? Math.ceil(Number(medication.totalQuantity || 0) / dailyConsumption) : 0;
  const calculatedEndDate = new Date(startDate);
  calculatedEndDate.setUTCDate(calculatedEndDate.getUTCDate() + totalDays - 1);
  calculatedEndDate.setUTCHours(23, 59, 59, 999);
  return calculatedEndDate;
}

function beforeReminderTime(actualMedicationTime, reminderBeforeMinutes) {
  if (!reminderBeforeMinutes) {
    return null;
  }
  return new Date(actualMedicationTime.getTime() - reminderBeforeMinutes * 60 * 1000);
}

function afterReminderTime(actualMedicationTime) {
  return new Date(
    actualMedicationTime.getTime() + env.afterReminderNotificationMinutes * 60 * 1000,
  );
}

function refillTime(endDate) {
  if (!env.refillAlertBeforeDays) {
    return null;
  }
  const end = new Date(endDate);
  end.setUTCHours(23, 59, 59, 999);
  return new Date(end.getTime() - env.refillAlertBeforeDays * 24 * 60 * 60 * 1000);
}

module.exports = {
  generateReminderOccurrences,
  calculateMedicationEndDate,
  beforeReminderTime,
  afterReminderTime,
  refillTime,
};
