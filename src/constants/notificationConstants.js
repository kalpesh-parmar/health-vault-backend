const notificationConstant = Object.freeze({
  BEFORE_REMINDER: "BEFORE_REMINDER",
  AFTER_REMINDER: "AFTER_REMINDER",
  REFILL_REMINDER: "REFILL_REMINDER",
  FOLLOW_UP_REMINDER: "FOLLOW_UP_REMINDER",
  BEFORE_MEDICATION_TEMPLATE: `🔔Upcoming dose {{medicineName}}. Be ready at {{localTime}}!`,
  AFTER_MEDICATION_TEMPLATE: `⁉️Did you take your {{medicineName}} at {{localTime}}?`,
  REFILL_ALERT_TEMPLATE: `💊 {{medicineName}} may be running low. Consider refilling soon.`,
  FOLLOW_UP_TEMPLATE: `⏰You may have missed your {{medicineName}} dose at {{localTime}}`,
});

module.exports = { notificationConstant };
