const { messageConstants } = require("../../src/constants/messageConstants");
const DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW =
  messageConstants.DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW;

describe("DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW Message Formatting Tests", () => {
  test("should format single document successful processing with medicines", () => {
    const msg = DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
      successfulCount: 1,
      totalCount: 1,
      medicationCount: 2,
      failedCount: 0,
    });
    expect(msg).toBe("1 document processed successfully.\nWe found 2 medications for your review.");
  });

  test("should format single document successful processing with 1 medicine", () => {
    const msg = DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
      successfulCount: 1,
      totalCount: 1,
      medicationCount: 1,
      failedCount: 0,
    });
    expect(msg).toBe("1 document processed successfully.\nWe found 1 medication for your review.");
  });

  test("should format single document failure case accurately without claiming success", () => {
    const msg = DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
      successfulCount: 0,
      totalCount: 1,
      medicationCount: 0,
      failedCount: 1,
    });
    expect(msg).toBe("1 document could not be processed.");
  });

  test("should format single document with zero medicines found", () => {
    const msg = DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
      successfulCount: 1,
      totalCount: 1,
      medicationCount: 0,
      failedCount: 0,
    });
    expect(msg).toBe("1 document processed successfully.\nNo medications found for review.");
  });

  test("should format multi-document processing correctly", () => {
    const msg = DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
      successfulCount: 2,
      totalCount: 3,
      medicationCount: 4,
      failedCount: 1,
    });
    expect(msg).toBe(
      "2 of 3 documents processed successfully.\nWe found 4 medications for your review.\n1 document could not be processed. Please retry them below.",
    );
  });

  test("should format single document in Gujarati preferred language", () => {
    const msg = DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
      successfulCount: 1,
      totalCount: 1,
      medicationCount: 2,
      failedCount: 0,
      language: "gujarati",
    });
    expect(msg).toBe("૧ દસ્તાવેજ સફળતાપૂર્વક પ્રોસેસ થયો.\nઅમે તમારી સમીક્ષા માટે 2 દવાઓ શોધી છે.");
  });

  test("should format multi-document in Gujarati preferred language", () => {
    const msg = DOCUMENT_MEDICATIONS_EXTRACTED_REVIEW({
      successfulCount: 2,
      totalCount: 3,
      medicationCount: 3,
      failedCount: 1,
      language: "gujarati",
    });
    expect(msg).toBe(
      "2 માંથી 3 દસ્તાવેજો સફળતાપૂર્વક પ્રોસેસ થયા.\nઅમે તમારી સમીક્ષા માટે 3 દવાઓ શોધી છે.\n1 દસ્તાવેજ પ્રોસેસ કરી શકાયા નથી. કૃપા કરીને નીચે ફરીથી પ્રયાસ કરો.",
    );
  });
});
