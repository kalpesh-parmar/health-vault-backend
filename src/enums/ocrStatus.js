const ocrStatus = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  IN_PROGRESS: "in_progress",
  PENDING: "pending",
  CANCELED: "canceled",
});

const ocrStatusValue = Object.values(ocrStatus);

module.exports = {
  ocrStatus,
  ocrStatusValue,
};
