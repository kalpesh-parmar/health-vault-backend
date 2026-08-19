const {
  documentTypeValue,
  normalizeDocumentType,
  isValidDocumentType,
} = require("../../src/enums/documentType");

describe("documentType Enum & Normalization Unit Tests", () => {
  test("documentType enum contains exactly 9 canonical values", () => {
    expect(documentTypeValue).toHaveLength(9);
    expect(documentTypeValue).toEqual(
      expect.arrayContaining([
        "PRESCERIPTION",
        "LAB_REPORT",
        "IMAGING_REPORT",
        "DISCHARGE_SUMMARY",
        "CONSULTATION_REPORT",
        "SURGERY_PROCEDURE_REPORT",
        "VACCINATION_RECORD",
        "MEDICAL_CERTIFICATE",
        "OTHER_MEDICAL_DOCUMENT",
      ]),
    );
  });

  test("isValidDocumentType helper works correctly", () => {
    expect(isValidDocumentType("IMAGING_REPORT")).toBe(true);
    expect(isValidDocumentType("PRESCERIPTION")).toBe(true);
    expect(isValidDocumentType("MEDICAL_DOCUMENT")).toBe(false);
    expect(isValidDocumentType("INSURANCE")).toBe(false);
    expect(isValidDocumentType(null)).toBe(false);
    expect(isValidDocumentType(undefined)).toBe(false);
  });

  test("normalizeDocumentType maps all required model strings & aliases correctly", () => {
    const cases = [
      { input: "X-ray / MRI / CT Scan report", expected: "IMAGING_REPORT" },
      { input: "x-ray", expected: "IMAGING_REPORT" },
      { input: "MRI report", expected: "IMAGING_REPORT" },
      { input: "CBC Report", expected: "LAB_REPORT" },
      { input: "blood_report", expected: "LAB_REPORT" },
      { input: "Prescription", expected: "PRESCERIPTION" },
      { input: "Doctor Note", expected: "CONSULTATION_REPORT" },
      { input: "Discharge Summary", expected: "DISCHARGE_SUMMARY" },
      { input: "Surgery Report", expected: "SURGERY_PROCEDURE_REPORT" },
      { input: "Vaccination Record", expected: "VACCINATION_RECORD" },
      { input: "Medical Certificate", expected: "MEDICAL_CERTIFICATE" },
      { input: "unknown medical type", expected: "OTHER_MEDICAL_DOCUMENT" },
      { input: "ECG chart", expected: "OTHER_MEDICAL_DOCUMENT" },
      { input: "random label", expected: "OTHER_MEDICAL_DOCUMENT" },
    ];

    cases.forEach(({ input, expected }) => {
      const normalized = normalizeDocumentType(input);
      expect(normalized).toBe(expected);
      expect(documentTypeValue).toContain(normalized);
    });
  });

  test("normalizeDocumentType handles empty/invalid inputs safely without returning undefined", () => {
    expect(normalizeDocumentType(null)).toBe("OTHER_MEDICAL_DOCUMENT");
    expect(normalizeDocumentType(undefined)).toBe("OTHER_MEDICAL_DOCUMENT");
    expect(normalizeDocumentType("")).toBe("OTHER_MEDICAL_DOCUMENT");
    expect(normalizeDocumentType("   ")).toBe("OTHER_MEDICAL_DOCUMENT");
    expect(normalizeDocumentType(123)).toBe("OTHER_MEDICAL_DOCUMENT");
  });
});
