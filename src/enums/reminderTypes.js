const reminderTypes = Object.freeze({
  BEFORE: "before",
  AFTER: "after",
  REFILL: "refill",
  OVERDUE: "overdue",
});
const reminderTypesValues = Object.values(reminderTypes);
module.exports = { reminderTypesValues, reminderTypes };
