const cron = require("node-cron");
const medicationRepository = require("../repositories/medicationRepository");
const medicationReminderRepository = require("../repositories/medicationReminderRepository");
const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const { reminderType } = require("../enums/reminderType");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");

//
// RUN EVERY DAY AT 12:00 AM
//
cron.schedule("0 0 * * *", async () => {
  try {
    console.log("⏰ Running generateOccurrencesCron...");

    //
    // GET ALL ACTIVE MEDICATIONS
    //
    const medications = await medicationRepository.findAllActive();

    if (!medications.length) {
      console.log("✅ No active medications found");

      return;
    }

    //
    // TOMORROW DATE
    //
    const tomorrow = new Date();

    tomorrow.setDate(tomorrow.getDate() + 1);

    tomorrow.setHours(0);
    tomorrow.setMinutes(0);
    tomorrow.setSeconds(0);
    tomorrow.setMilliseconds(0);

    //
    // LOOP MEDICATIONS
    //
    for (const medication of medications) {
      try {
        //
        // FIND REMINDER
        //
        const reminder = await medicationReminderRepository.findByMedicationId(medication.id);

        if (!reminder) {
          continue;
        }

        //
        // CHECK END DATE
        //
        if (medication.endDate && new Date(medication.endDate) < tomorrow) {
          continue;
        }

        //
        // GENERATE OCCURRENCES
        //
        const occurrences = [];

        const medicationTimes = medication.medicationTime || [];

        for (const timeObj of medicationTimes) {
          const [hours, minutes] = timeObj.time.split(":");

          //
          // ACTUAL MEDICATION TIME
          //
          const medicationDateTime = new Date(tomorrow);

          medicationDateTime.setHours(Number(hours));

          medicationDateTime.setMinutes(Number(minutes));

          medicationDateTime.setSeconds(0);

          //
          // BEFORE REMINDER
          //
          const beforeTime = new Date(
            medicationDateTime.getTime() - reminder.reminderBeforeMinutes * 60000,
          );

          occurrences.push({
            reminderId: reminder.id,

            type: reminderType.BEFORE_MEDICATION,

            status: reminderOccurrenceStatus.PENDING,

            scheduledAt: beforeTime,

            actualMedicationTime: medicationDateTime,
          });

          //
          // AFTER REMINDER
          //
          const afterTime = new Date(
            medicationDateTime.getTime() + reminder.afterReminderMinutes * 60000,
          );

          occurrences.push({
            reminderId: reminder.id,

            type: reminderType.AFTER_MEDICATION,

            status: reminderOccurrenceStatus.PENDING,

            scheduledAt: afterTime,

            actualMedicationTime: medicationDateTime,
          });
        }

        //
        // REFILL ALERT
        //
        if (medication.refillAlert && medication.endDate) {
          const refillDate = new Date(medication.endDate);

          refillDate.setDate(refillDate.getDate() - reminder.refillAlertBeforeDays);

          refillDate.setHours(9);

          refillDate.setMinutes(0);

          refillDate.setSeconds(0);

          //
          // ONLY TOMORROW
          //
          if (refillDate.toDateString() === tomorrow.toDateString()) {
            occurrences.push({
              reminderId: reminder.id,

              type: reminderType.REFILL_ALERT,

              status: reminderOccurrenceStatus.PENDING,

              scheduledAt: refillDate,
            });
          }
        }

        //
        // SAVE OCCURRENCES
        //
        if (occurrences.length) {
          await medicationReminderOccurrenceRepository.bulkCreate(occurrences);

          console.log(
            `✅ Generated ${occurrences.length} reminders for medication: ${medication.id}`,
          );
        }
      } catch (error) {
        console.error(`❌ Failed medication occurrence generation: ${medication.id}`, error);
      }
    }
  } catch (error) {
    console.error("❌ generateOccurrencesCron error:", error);
  }
});

console.log("✅ generateOccurrencesCron started...");
