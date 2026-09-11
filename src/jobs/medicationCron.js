/**
 * Medication Cron Handler (Consolidated & Layer-Aligned)
 *
 * NOTE: Scheduled medication adherence tasks are registered in src/configs/cronConfig.js
 * and orchestrated via src/services/cron.service.js and src/services/reminder.service.js.
 * This file is retained for backwards-compatibility of job exports.
 */

const reminderService = require("../services/reminder.service");

async function runMedicationReminders() {
  await reminderService.processReminders();
}

module.exports = {
  runMedicationReminders,
};
