const reminderOccurrenceStatus = Object.freeze({
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  // OVERDUE: "OVERDUE",
});

const reminderOccurrenceStatusValues = Object.values(reminderOccurrenceStatus);

module.exports = {
  reminderOccurrenceStatus,
  reminderOccurrenceStatusValues,
};
