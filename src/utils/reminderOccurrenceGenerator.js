const moment = require("moment-timezone");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");

function generateReminderOccurrences(reminder, medication) {
  const occurrences = [];
  const medicationTimes = medication.medicationTime || [];

  // user timezone
  const userTimezone = medication.timezone || "Asia/Kolkata";

  const currentDate = new Date(medication.startDate);
  currentDate.setUTCHours(0, 0, 0, 0);

  const endDate = calculateMedicationEndDate(medication);

  let consumedQuantity = 0;

  while (currentDate <= endDate) {
    for (const timeObj of medicationTimes) {
      const dosePerIntake = Number(medication.dosePerIntake || 1);

      const totalQuantity = Number(medication.totalQuantity || 0);

      // stop if stock finished
      if (totalQuantity > 0 && consumedQuantity + dosePerIntake > totalQuantity) {
        return occurrences;
      }

      let [hours, minutes] = timeObj.time.split(":").map(Number);

      const period = timeObj.period.toUpperCase();

      // convert AM/PM -> 24 hour
      if (period === "PM" && hours !== 12) {
        hours += 12;
      }

      if (period === "AM" && hours === 12) {
        hours = 0;
      }

      // local datetime in user timezone
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

      // convert to UTC
      const actualMedicationTime = localDateTime.clone().utc().toDate();
      console.log("USER TIMEZONE:", userTimezone);
      console.log("INPUT TIME:", timeObj.time, timeObj.period);
      console.log("LOCAL:", localDateTime.format());
      console.log("UTC:", localDateTime.clone().utc().format());
      console.log("DATE:", actualMedicationTime);
      console.log("ISO:", actualMedicationTime.toISOString());
      // before reminder
      const beforeReminderTime = new Date(
        actualMedicationTime.getTime() - reminder.reminderBeforeMinutes * 60000,
      );

      // after reminder
      const afterReminderTime = new Date(
        actualMedicationTime.getTime() + reminder.afterReminderMinutes * 60000,
      );

      occurrences.push({
        reminderId: reminder.id,
        medicationId: medication.id,
        patientId: medication.userId,
        status: reminderOccurrenceStatus.PENDING,

        actualMedicationTime,
        beforeReminderTime,
        afterReminderTime,

        notificationSent: false,
        notificationSentAt: null,
        completedAt: null,
        isFollowUp: false,
        softDelete: false,
      });

      consumedQuantity += dosePerIntake;
    }

    currentDate.setUTCDate(currentDate.getUTCDate() + 1);
  }

  return occurrences;

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
      dailyConsumption > 0
        ? Math.floor(Number(medication.totalQuantity || 0) / dailyConsumption)
        : 0;

    const calculatedEndDate = new Date(startDate);
    calculatedEndDate.setUTCDate(calculatedEndDate.getUTCDate() + totalDays);

    calculatedEndDate.setUTCHours(23, 59, 59, 999);

    return calculatedEndDate;
  }
}

module.exports = generateReminderOccurrences;

// const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");
// function generateReminderOccurrences(reminder, medication) {
//   const occurrences = [];
//   const medicationTimes = medication.medicationTime || [];

//   const currentDate = new Date(medication.startDate);
//   currentDate.setUTCHours(0, 0, 0, 0);

//   // END DATE
//   const endDate = calculateMedicationEndDate(medication);
//   let consumedQuantity = 0;

//   while (currentDate <= endDate) {
//     for (const timeObj of medicationTimes) {
//       const dosePerIntake = Number(medication.dosePerIntake || 1);
//       const totalQuantity = Number(medication.totalQuantity || 0);

//       // stop if stock finished
//       if (totalQuantity > 0 && consumedQuantity + dosePerIntake > totalQuantity) {
//         return occurrences;
//       }

//       const [hours, minutes] = timeObj.time.split(":").map(Number);

//       const actualMedicationTime = new Date(
//         Date.UTC(
//           currentDate.getUTCFullYear(),
//           currentDate.getUTCMonth(),
//           currentDate.getUTCDate(),
//           hours,
//           minutes,
//           0,
//           0,
//         ),
//       );

//       // before reminder
//       const beforeReminderTime = new Date(
//         actualMedicationTime.getTime() - reminder.reminderBeforeMinutes * 60000,
//       );

//       // after reminder
//       const afterReminderTime = new Date(
//         actualMedicationTime.getTime() + reminder.afterReminderMinutes * 60000,
//       );

//       const status = reminderOccurrenceStatus.PENDING;

//       occurrences.push({
//         reminderId: reminder.id,
//         medicationId: medication.id,
//         patientId: medication.userId,
//         status,

//         actualMedicationTime,
//         beforeReminderTime,
//         afterReminderTime,

//         notificationSent: false,
//         notificationSentAt: null,
//         completedAt: null,
//         isFollowUp: false,
//         softDelete: false,
//       });

//       consumedQuantity += dosePerIntake;
//     }

//     // next day (UTC safe)
//     currentDate.setUTCDate(currentDate.getUTCDate() + 1);
//   }

//   return occurrences;
// }

// // =========================
// // END DATE CALCULATION
// // =========================

// module.exports = generateReminderOccurrences;
