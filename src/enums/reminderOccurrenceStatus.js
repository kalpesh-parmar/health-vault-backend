const reminderOccurrenceStatus = Object.freeze({
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
  SKIPPED: "SKIPPED",
  CANCELLED: "CANCELLED",
});

const reminderOccurrenceStatusValues = Object.values(reminderOccurrenceStatus);

module.exports = {
  reminderOccurrenceStatus,
  reminderOccurrenceStatusValues,
};
