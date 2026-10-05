const cronService = require("../services/cron.service");
const reminderService = require("../services/reminder.service");

async function cronRegisterHandler() {
  cronService.register("SEND_REMINDERS", async () => {
    await reminderService.processReminders();
  });
  cronService.register("PROCESS_OVERDUE", async () => {
    await reminderService.processOverdueOccurrences();
  });
}
module.exports = cronRegisterHandler;
