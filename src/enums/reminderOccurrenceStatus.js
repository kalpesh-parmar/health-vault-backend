const reminderOccurrenceStatus = Object.freeze({
  PENDING: "PENDING",
  SENT: "SENT",
  COMPLETED: "COMPLETED",
  MISSED: "MISSED",
  SKIPPED: "SKIPPED",
  SNOOZED: "SNOOZED",
  OVERDUE: "OVERDUE",
});

const reminderOccurrenceStatusValues = Object.values(reminderOccurrenceStatus);

module.exports = {
  reminderOccurrenceStatus,
  reminderOccurrenceStatusValues,
};
