const notificationType = Object.freeze({
  BEFORE_MEDICATION_REMINDER: "BEFORE_MEDICATION_REMINDER",
  AFTER_MEDICATION_REMINDER: "AFTER_MEDICATION_REMINDER",
  FOLLOW_UP_MEDICATION_REMINDER: "FOLLOW_UP_MEDICATION_REMINDER",
  REFILL_ALERT: "REFILL_ALERT",
});

const notificationTypeValues = Object.values(notificationType);

module.exports = {
  notificationType,
  notificationTypeValues,
};
