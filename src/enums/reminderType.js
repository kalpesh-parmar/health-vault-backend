const reminderType = Object.freeze({
  BEFORE_MEDICATION: "BEFORE_MEDICATION",
  AFTER_MEDICATION: "AFTER_MEDICATION",
  REFILL_ALERT: "REFILL_ALERT",
});

const reminderTypeValues = Object.values(reminderType);

module.exports = {
  reminderType,
  reminderTypeValues,
};