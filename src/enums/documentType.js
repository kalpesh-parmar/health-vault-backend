const documentType = Object.freeze({
  DISCHARGE_SUMMARY: "discharge_summary",
  IMAGING_REPORT: "imaging_report",
  LAB_REPORT: "lab_report",
  OTHER: "other",
  PRESCRIPTION: "prescription",
});

const documentTypeValue = Object.values(documentType);

module.exports = {
  documentType,
  documentTypeValue,
};
