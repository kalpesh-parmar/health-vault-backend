const notificationType = Object.freeze({
  MEDICATION_REMINDER: "MEDICATION_REMINDER",
  REFILL_ALERT: "REFILL_ALERT",
  OVERDUE_REMINDER: "OVERDUE_REMINDER",
});

const notificationTypeValues = Object.values(notificationType);

module.exports = {
  notificationType,
  notificationTypeValues,
};
