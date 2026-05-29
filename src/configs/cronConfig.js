const cronService = require("../services/cronService");
const reminderService = require("../services/reminderService");

async function cronRegisterHandler() {
  cronService.register("SEND_REMINDERS", async () => reminderService.sendReminder());
}
module.exports = cronRegisterHandler;
