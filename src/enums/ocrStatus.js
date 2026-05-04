const ocrStatus = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  IN_PROGRESS: "in_progress",
  PENDING: "pending",
});

const ocrStatusValue = Object.values(ocrStatus);

module.exports = {
  ocrStatus,
  ocrStatusValue,
};
