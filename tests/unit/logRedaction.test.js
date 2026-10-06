const { redact } = require("../../src/services/ai/ocr/ocr.logger");

describe("OCR Logger and Redaction Hardening (Commit 4F)", () => {
  it("redacts patient identifiers and contact information", () => {
    const payload = {
      patientName: "Jane Doe",
      patient_name: "Jane Doe",
      firstName: "Jane",
      lastName: "Doe",
      phone: "+91 9876543210",
      phoneNumber: "9876543210",
      email: "patient@example.com",
      caseId: "CASE-12345",
      uhid: "UHID-9999",
      doctorName: "Dr. Smith",
    };

    const cleaned = redact(payload);
    expect(cleaned.patientName).toBe("[redacted]");
    expect(cleaned.patient_name).toBe("[redacted]");
    expect(cleaned.firstName).toBe("[redacted]");
    expect(cleaned.lastName).toBe("[redacted]");
    expect(cleaned.phone).toBe("[redacted]");
    expect(cleaned.phoneNumber).toBe("[redacted]");
    expect(cleaned.email).toBe("[redacted]");
    expect(cleaned.caseId).toBe("[redacted]");
    expect(cleaned.uhid).toBe("[redacted]");
    expect(cleaned.doctorName).toBe("[redacted]");
  });

  it("redacts raw OCR text and long text payloads", () => {
    const payload = {
      rawText: "Hemoglobin (Hb) 11.2 gm/dL Reference Range 12-15...",
      raw_text: "Random Blood Sugar 185 mg/dL...",
      fullText: "Patient report details and clinical notes...",
      ocrText: "Sample text from digital scan...",
    };

    const cleaned = redact(payload);
    expect(cleaned.rawText).toBe("[redacted]");
    expect(cleaned.raw_text).toBe("[redacted]");
    expect(cleaned.fullText).toBe("[redacted]");
    expect(cleaned.ocrText).toBe("[redacted]");
  });

  it("redacts nested objects and arrays without mutating non-sensitive metadata", () => {
    const nested = {
      documentId: "doc_123",
      metadata: {
        pageCount: 6,
        patientInfo: {
          name: "Secret Patient",
          uhid: "12345",
        },
      },
      tags: ["lab_report", "cbc"],
    };

    const cleaned = redact(nested);
    expect(cleaned.documentId).toBe("doc_123");
    expect(cleaned.metadata.pageCount).toBe(6);
    expect(cleaned.metadata.patientInfo.name).toBe("[redacted]");
    expect(cleaned.metadata.patientInfo.uhid).toBe("[redacted]");
    expect(cleaned.tags).toEqual(["lab_report", "cbc"]);
  });
});
