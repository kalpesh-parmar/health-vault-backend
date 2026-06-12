const notificationConstant = Object.freeze({
  BEFORE_REMINDER: "Before reminder",
  AFTER_REMINDER: "After reminder",
  REFILL_REMINDER: "Refill reminder",
  FOLLOW_UP_REMINDER: "Follow up reminder",
  BEFORE_MEDICATION_TEMPLATE: `🔔Upcoming dose {{medicineName}}. Be ready at {{localTime}}!`,
  AFTER_MEDICATION_TEMPLATE: `⁉️Did you take your {{medicineName}} at {{localTime}}?`,
  REFILL_ALERT_TEMPLATE: `💊 {{medicineName}} may be running low. Consider refilling soon.`,
  FOLLOW_UP_TEMPLATE: `⏰You may have missed your {{medicineName}} dose at {{localTime}}`,
});

module.exports = { notificationConstant };
