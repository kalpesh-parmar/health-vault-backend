const reminderOccurrenceStatus = Object.freeze({
  PENDING: "PENDING",
  COMPLETED: "COMPLETED",
});

const reminderOccurrenceStatusValues = Object.values(reminderOccurrenceStatus);

module.exports = {
  reminderOccurrenceStatus,
  reminderOccurrenceStatusValues,
};
