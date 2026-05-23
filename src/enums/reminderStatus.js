const reminderStatus = Object.freeze({
  ACTIVE: "ACTIVE",
  PAUSED: "PAUSED",
  STOPPED: "STOPPED",
});

const reminderStatusValues = Object.values(reminderStatus);

module.exports = {
  reminderStatus,
  reminderStatusValues,
};