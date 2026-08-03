const documentType = Object.freeze({
  FAMILY: "family",
  MEDICAL_DOCUMENT: "medical_document",
  MEDICATION: "medication",
  INSURANCE: "insurance",
  PRESCRIPTION: "prescription",
  LAB_REPORT: "lab report",
  IMAGING_REPORT: "imaging report",
  DISCHARGE_SUMMARY: "discharge summary",
  CONSULTATION_REPORT: "consultation report",
  SURGERY_PROCEDURE_REPORT: "surgery procedure report",
  VACCINATION_RECORD: "vaccination record",
  MEDICAL_CERTIFICATE: "medical certificate",
  OTHER_MEDICAL_DOCUMENT: "other medical document",
});

const documentTypeValue = Object.values(documentType);

function normalizeDocumentType(rawType) {
  if (!rawType || typeof rawType !== "string") {
    return documentType.MEDICAL_DOCUMENT;
  }

  const cleaned = rawType.trim().toLowerCase();
  if (!cleaned) return documentType.MEDICAL_DOCUMENT;

  if (documentTypeValue.includes(cleaned)) {
    return cleaned;
  }

  const spaceNormalized = cleaned.replace(/_/g, " ");
  if (documentTypeValue.includes(spaceNormalized)) {
    return spaceNormalized;
  }

  const underscoreNormalized = cleaned.replace(/\s+/g, "_");
  if (documentTypeValue.includes(underscoreNormalized)) {
    return underscoreNormalized;
  }

  const aliasMap = {
    lab: documentType.LAB_REPORT,
    lab_report: documentType.LAB_REPORT,
    laboratory_report: documentType.LAB_REPORT,
    lab_test: documentType.LAB_REPORT,
    test_report: documentType.LAB_REPORT,
    blood_test: documentType.LAB_REPORT,
    blood_report: documentType.LAB_REPORT,
    cbc_report: documentType.LAB_REPORT,
    cbc_test: documentType.LAB_REPORT,
    pathology_report: documentType.LAB_REPORT,
    biochemistry_report: documentType.LAB_REPORT,
    lipid_profile: documentType.LAB_REPORT,
    thyroid_report: documentType.LAB_REPORT,
    blood_work: documentType.LAB_REPORT,
    prescription: documentType.PRESCRIPTION,
    prescriptions: documentType.PRESCRIPTION,
    rx: documentType.PRESCRIPTION,
    xray: documentType.IMAGING_REPORT,
    "x-ray": documentType.IMAGING_REPORT,
    mri: documentType.IMAGING_REPORT,
    ct_scan: documentType.IMAGING_REPORT,
    ultrasound: documentType.IMAGING_REPORT,
    ecg: documentType.IMAGING_REPORT,
    ecg_report: documentType.IMAGING_REPORT,
    ekg: documentType.IMAGING_REPORT,
    heart_rate: documentType.IMAGING_REPORT,
    heart_rate_report: documentType.IMAGING_REPORT,
    cardiogram: documentType.IMAGING_REPORT,
    cardiology_report: documentType.IMAGING_REPORT,
    medical_chart: documentType.IMAGING_REPORT,
    graphical_report: documentType.IMAGING_REPORT,
    discharge: documentType.DISCHARGE_SUMMARY,
    discharge_summary: documentType.DISCHARGE_SUMMARY,
    consultation: documentType.CONSULTATION_REPORT,
    consultation_report: documentType.CONSULTATION_REPORT,
    doctor_note: documentType.CONSULTATION_REPORT,
    surgery: documentType.SURGERY_PROCEDURE_REPORT,
    surgery_report: documentType.SURGERY_PROCEDURE_REPORT,
    procedure_report: documentType.SURGERY_PROCEDURE_REPORT,
    vaccine: documentType.VACCINATION_RECORD,
    vaccination: documentType.VACCINATION_RECORD,
    vaccination_record: documentType.VACCINATION_RECORD,
    certificate: documentType.MEDICAL_CERTIFICATE,
    medical_certificate: documentType.MEDICAL_CERTIFICATE,
    insurance_claim: documentType.INSURANCE,
    insurance_policy: documentType.INSURANCE,
    medical_record: documentType.MEDICAL_DOCUMENT,
    medical_report: documentType.MEDICAL_DOCUMENT,
  };

  if (aliasMap[cleaned]) {
    return aliasMap[cleaned];
  }
  if (aliasMap[spaceNormalized]) {
    return aliasMap[spaceNormalized];
  }
  if (aliasMap[underscoreNormalized]) {
    return aliasMap[underscoreNormalized];
  }

  return documentType.MEDICAL_DOCUMENT;
}

module.exports = {
  documentType,
  documentTypeValue,
  normalizeDocumentType,
};
