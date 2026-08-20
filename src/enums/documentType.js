const documentType = Object.freeze({
  PRESCRIPTION: "PRESCERIPTION",
  LAB_REPORT: "LAB_REPORT",
  IMAGING_REPORT: "IMAGING_REPORT",
  DISCHARGE_SUMMARY: "DISCHARGE_SUMMARY",
  CONSULTATION_REPORT: "CONSULTATION_REPORT",
  SURGERY_PROCEDURE_REPORT: "SURGERY_PROCEDURE_REPORT",
  VACCINATION_RECORD: "VACCINATION_RECORD",
  MEDICAL_CERTIFICATE: "MEDICAL_CERTIFICATE",
  OTHER_MEDICAL_DOCUMENT: "OTHER_MEDICAL_DOCUMENT",
});

const documentTypeValue = Object.values(documentType);

const aliasMap = {
  // Prescription
  prescription: documentType.PRESCRIPTION,
  prescriptions: documentType.PRESCRIPTION,
  rx: documentType.PRESCRIPTION,
  "prescription slip": documentType.PRESCRIPTION,
  "prescription slips": documentType.PRESCRIPTION,
  presceription: documentType.PRESCRIPTION,

  // Lab report
  lab: documentType.LAB_REPORT,
  lab_report: documentType.LAB_REPORT,
  laboratory_report: documentType.LAB_REPORT,
  lab_test: documentType.LAB_REPORT,
  test_report: documentType.LAB_REPORT,
  blood_test: documentType.LAB_REPORT,
  blood_report: documentType.LAB_REPORT,
  cbc: documentType.LAB_REPORT,
  cbc_report: documentType.LAB_REPORT,
  cbc_test: documentType.LAB_REPORT,
  pathology: documentType.LAB_REPORT,
  pathology_report: documentType.LAB_REPORT,
  biochemistry: documentType.LAB_REPORT,
  biochemistry_report: documentType.LAB_REPORT,
  lipid_profile: documentType.LAB_REPORT,
  thyroid: documentType.LAB_REPORT,
  thyroid_report: documentType.LAB_REPORT,
  blood_work: documentType.LAB_REPORT,

  // Imaging report
  imaging: documentType.IMAGING_REPORT,
  imaging_report: documentType.IMAGING_REPORT,
  xray: documentType.IMAGING_REPORT,
  "x-ray": documentType.IMAGING_REPORT,
  x_ray: documentType.IMAGING_REPORT,
  mri: documentType.IMAGING_REPORT,
  mri_report: documentType.IMAGING_REPORT,
  ct: documentType.IMAGING_REPORT,
  ct_scan: documentType.IMAGING_REPORT,
  ct_scan_report: documentType.IMAGING_REPORT,
  ultrasound: documentType.IMAGING_REPORT,
  sonography: documentType.IMAGING_REPORT,
  radiograph: documentType.IMAGING_REPORT,
  radiology: documentType.IMAGING_REPORT,
  scan: documentType.IMAGING_REPORT,
  "x-ray / mri / ct scan report": documentType.IMAGING_REPORT,
  "x-ray/mri/ct scan report": documentType.IMAGING_REPORT,
  "x ray mri ct scan report": documentType.IMAGING_REPORT,

  // Discharge summary
  discharge: documentType.DISCHARGE_SUMMARY,
  discharge_summary: documentType.DISCHARGE_SUMMARY,
  hospital_discharge: documentType.DISCHARGE_SUMMARY,
  hospital_discharge_summary: documentType.DISCHARGE_SUMMARY,
  discharge_report: documentType.DISCHARGE_SUMMARY,

  // Consultation report
  consultation: documentType.CONSULTATION_REPORT,
  consultation_report: documentType.CONSULTATION_REPORT,
  doctor_note: documentType.CONSULTATION_REPORT,
  doctor_notes: documentType.CONSULTATION_REPORT,
  clinical_note: documentType.CONSULTATION_REPORT,
  clinical_notes: documentType.CONSULTATION_REPORT,
  symptoms: documentType.CONSULTATION_REPORT,
  opd_note: documentType.CONSULTATION_REPORT,
  outpatient_note: documentType.CONSULTATION_REPORT,

  // Surgery / Procedure report
  surgery: documentType.SURGERY_PROCEDURE_REPORT,
  surgery_report: documentType.SURGERY_PROCEDURE_REPORT,
  procedure: documentType.SURGERY_PROCEDURE_REPORT,
  procedure_report: documentType.SURGERY_PROCEDURE_REPORT,
  operation_report: documentType.SURGERY_PROCEDURE_REPORT,
  operative_note: documentType.SURGERY_PROCEDURE_REPORT,
  surgical_report: documentType.SURGERY_PROCEDURE_REPORT,

  // Vaccination record
  vaccine: documentType.VACCINATION_RECORD,
  vaccination: documentType.VACCINATION_RECORD,
  vaccination_record: documentType.VACCINATION_RECORD,
  immunization: documentType.VACCINATION_RECORD,
  immunization_record: documentType.VACCINATION_RECORD,

  // Medical certificate
  certificate: documentType.MEDICAL_CERTIFICATE,
  medical_certificate: documentType.MEDICAL_CERTIFICATE,
  fitness_certificate: documentType.MEDICAL_CERTIFICATE,
  illness_certificate: documentType.MEDICAL_CERTIFICATE,
  leave_certificate: documentType.MEDICAL_CERTIFICATE,
  medical_leave_certificate: documentType.MEDICAL_CERTIFICATE,
  sick_note: documentType.MEDICAL_CERTIFICATE,

  // Other medical document
  other_medical_document: documentType.OTHER_MEDICAL_DOCUMENT,
  other_medical_report: documentType.OTHER_MEDICAL_DOCUMENT,
  medical_document: documentType.OTHER_MEDICAL_DOCUMENT,
  medical_report: documentType.OTHER_MEDICAL_DOCUMENT,
  pharmacy_bill: documentType.OTHER_MEDICAL_DOCUMENT,
  medical_invoice: documentType.OTHER_MEDICAL_DOCUMENT,
  medical_bill: documentType.OTHER_MEDICAL_DOCUMENT,
  ecg: documentType.OTHER_MEDICAL_DOCUMENT,
  ecg_report: documentType.OTHER_MEDICAL_DOCUMENT,
  ekg: documentType.OTHER_MEDICAL_DOCUMENT,
  heart_rate: documentType.OTHER_MEDICAL_DOCUMENT,
  medical_chart: documentType.OTHER_MEDICAL_DOCUMENT,
};

function isValidDocumentType(type) {
  return typeof type === "string" && documentTypeValue.includes(type);
}

function normalizeDocumentType(rawType) {
  if (!rawType || typeof rawType !== "string") {
    return documentType.OTHER_MEDICAL_DOCUMENT;
  }

  const trimmed = rawType.trim();
  if (!trimmed) return documentType.OTHER_MEDICAL_DOCUMENT;

  const upper = trimmed.toUpperCase();
  if (documentTypeValue.includes(upper)) {
    return upper;
  }

  const lower = trimmed.toLowerCase();
  if (aliasMap[lower]) {
    return aliasMap[lower];
  }

  const spaced = lower.replace(/[\s\-_/.]+/g, " ").trim();
  if (aliasMap[spaced]) {
    return aliasMap[spaced];
  }

  const underscore = lower.replace(/[\s\-_/.]+/g, "_").trim();
  if (aliasMap[underscore]) {
    return aliasMap[underscore];
  }

  if (
    /\b(x-ray|xray|mri|ct|ct scan|ultrasound|sonography|imaging|radiology|radiograph)\b/i.test(
      lower,
    )
  ) {
    return documentType.IMAGING_REPORT;
  }
  if (/\b(blood|cbc|lab|labs|laboratory|pathology|biochemistry)\b/i.test(lower)) {
    return documentType.LAB_REPORT;
  }
  if (/\b(prescription|prescriptions|presceription|rx)\b/i.test(lower)) {
    return documentType.PRESCRIPTION;
  }
  if (/\b(discharge)\b/i.test(lower)) {
    return documentType.DISCHARGE_SUMMARY;
  }
  if (/\b(consultation|doctor note|clinical note|opd note)\b/i.test(lower)) {
    return documentType.CONSULTATION_REPORT;
  }
  if (/\b(surgery|procedure|operation|operative)\b/i.test(lower)) {
    return documentType.SURGERY_PROCEDURE_REPORT;
  }
  if (/\b(vaccin|vaccine|vaccination|immuniz|immunization)\b/i.test(lower)) {
    return documentType.VACCINATION_RECORD;
  }
  if (/\b(certificate)\b/i.test(lower)) {
    return documentType.MEDICAL_CERTIFICATE;
  }

  return documentType.OTHER_MEDICAL_DOCUMENT;
}

module.exports = {
  documentType,
  documentTypeValue,
  normalizeDocumentType,
  isValidDocumentType,
};
