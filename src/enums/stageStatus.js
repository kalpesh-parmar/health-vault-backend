const StageType = Object.freeze({
  QUEUED: "QUEUED",
  CONNECTED: "CONNECTED",
  STARTED: "STARTED",
  IN_PROGRESS: "IN_PROGRESS",
  COMPLETED: "COMPLETED",
  FAILED: "FAILED",
  CANCELLED: "CANCELLED",
});

const ProcessStatus = Object.freeze({
  SUCCESS: "SUCCESS",
  FAILED: "FAILED",
});

module.exports = {
  StageType,
  ProcessStatus,
};
