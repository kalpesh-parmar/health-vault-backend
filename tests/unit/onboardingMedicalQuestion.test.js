const ocrService = require("../../src/services/ocr.service");

describe("isOnboardingMedicalQuestion classification unit tests", () => {
  const { isOnboardingMedicalQuestion } = ocrService;

  describe("Onboarding actions and event messages must NOT be classified as medical QA", () => {
    test("DOCUMENT_UPLOADED message returns false", () => {
      expect(isOnboardingMedicalQuestion({ message: "DOCUMENT_UPLOADED" })).toBe(false);
      expect(
        isOnboardingMedicalQuestion({
          message: "DOCUMENT_UPLOADED",
          actionType: "DOCUMENT_UPLOADED",
        }),
      ).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "document_uploaded" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "Document Uploaded: report.pdf" })).toBe(false);
    });

    test("UPLOAD and MANUAL flow selection actions return false", () => {
      expect(isOnboardingMedicalQuestion({ message: "UPLOAD" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "DOC_UPLOAD" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "MANUAL" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "MANUAL_ENTRY" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "SKIP" })).toBe(false);
    });

    test("Profile source and document resolution actions return false", () => {
      expect(isOnboardingMedicalQuestion({ message: "USE_DOCUMENT" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "DOCUMENT" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "USE_DOCUMENT_DATA" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "DOCUMENT_DATA" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "USE_SOCIAL" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "LOGIN" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "CONFIRM_DOCUMENT_OWNERSHIP" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "RESOLVE_PROFILE_SOURCE" })).toBe(false);
    });

    test("Ownership and basic answers return false", () => {
      expect(isOnboardingMedicalQuestion({ message: "YES" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "NO" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "હા" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "ના" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "male" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "female" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "B+" })).toBe(false);
    });

    test("JSON action payloads return false", () => {
      expect(isOnboardingMedicalQuestion({ message: JSON.stringify({ source: "DOCUMENT" }) })).toBe(
        false,
      );
      expect(
        isOnboardingMedicalQuestion({ message: JSON.stringify({ action: "CONFIRM_MEDICINES" }) }),
      ).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: JSON.stringify({ confirmed: true }) })).toBe(
        false,
      );
    });

    test("ASK_REPORT and report summary action messages return false", () => {
      expect(isOnboardingMedicalQuestion({ message: "ASK_REPORT" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "ASK_REPORT", actionType: "ASK_REPORT" })).toBe(
        false,
      );
      expect(isOnboardingMedicalQuestion({ message: "ASK_ABOUT_REPORT" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "REPORT_SUMMARY" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "Ask About My Report" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "Ask about report" })).toBe(false);
      expect(isOnboardingMedicalQuestion({ message: "મારા રિપોર્ટ વિશે પૂછો" })).toBe(false);
      expect(
        isOnboardingMedicalQuestion({ message: "Show report", actionType: "ASK_REPORT" }),
      ).toBe(false);
    });
  });

  describe("Real medical questions about documents/medications return true", () => {
    test("Legitimate English document question returns true", () => {
      expect(
        isOnboardingMedicalQuestion({
          message: "What does my hemoglobin level indicate in this report?",
          preferredLanguage: "english",
        }),
      ).toBe(true);
    });

    test("Suggested report question returns true", () => {
      expect(
        isOnboardingMedicalQuestion({
          message: "Explain this report",
          preferredLanguage: "english",
        }),
      ).toBe(true);
    });

    test("Gujarati medical question returns true", () => {
      expect(
        isOnboardingMedicalQuestion({
          message: "આ રિપોર્ટમાં શું ખામી છે?",
          preferredLanguage: "gujarati",
        }),
      ).toBe(true);
    });
  });
});
