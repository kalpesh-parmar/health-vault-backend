const documentType = Object.freeze({
  FAMILY: "family",
  MEDICAL_DOCUMENT: "medical_document",
  MEDICATION: "medication",
  INSURANCE: "insurance",
  OTHER: "other",
});

const documentTypeValue = Object.values(documentType);

module.exports = {
  documentType,
  documentTypeValue,
};
