const cron = require("node-cron");

const medicationReminderOccurrenceRepository = require("../repositories/medicationReminderOccurrenceRepository");
const reminderNotificationService = require("../services/reminderNotificationService");
const { reminderOccurrenceStatus } = require("../enums/reminderOccurrenceStatus");

//
// EVERY MINUTE
//
cron.schedule("* * * * *", async () => {
  try {
    console.log("⏰ Running reminder cron...");

    //
    // FIND PENDING + SNOOZED REMINDERS
    //
    const reminders = await medicationReminderOccurrenceRepository.findPendingReminders([
      reminderOccurrenceStatus.PENDING,

      reminderOccurrenceStatus.SNOOZED,
    ]);

    if (!reminders.length) {
      console.log("✅ No reminders to send");

      return;
    }

    //
    // LOOP REMINDERS
    //
    for (const reminder of reminders) {
      try {
        //
        // SEND NOTIFICATION
        //
        await reminderNotificationService.sendReminderNotification(reminder);

        //
        // UPDATE STATUS -> SENT
        //
        await medicationReminderOccurrenceRepository.updateStatus(
          reminder.id,

          reminderOccurrenceStatus.SENT,

          {
            sentAt: new Date(),
          },
        );

        console.log(`✅ Reminder sent: ${reminder.id}`);
      } catch (error) {
        console.error(`❌ Failed reminder: ${reminder.id}`, error);
      }
    }
  } catch (error) {
    console.error("❌ Reminder cron error:", error);
  }
});

console.log("✅ sendReminderCron started...");
