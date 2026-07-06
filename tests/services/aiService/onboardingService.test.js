/* global jest, describe, beforeEach, it, expect */
const { onboardingService } = require("../../../src/services/ai/chat/onboarding.service");
const { ollamaClient } = require("../../../src/services/ai/clients/ollamaClient");

jest.mock("../../../src/services/ai/clients/ollamaClient", () => ({
  ollamaClient: {
    chat: jest.fn(),
  },
}));

jest.mock("../../../src/repositories/patientRepository", () => ({
  updateById: jest.fn().mockResolvedValue({}),
  findById: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../../src/repositories/userOnboardingRepository", () => ({
  findByUserId: jest.fn().mockResolvedValue(null),
  updateByUserId: jest.fn().mockResolvedValue({}),
  create: jest.fn().mockResolvedValue({}),
}));

describe("OnboardingService Structured Flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("Case 1: Document contains complete required fields (Sarah Anderson, DOB: 01.01.1989, Gender: Female) + optional email", async () => {
    const mockState = {
      isOnboardingCompleted: false,
      uploadedMedicalDocument: true,
      documentText:
        "Patient Name: Sarah Anderson, DOB: 01.01.1989, Sex: Female, Email: sarah@anderson.com",
      preferredLanguage: "en",
      flowMode: "UPLOAD",
      currentStep: "ASK_FIRST_NAME",
      documentExtracted: false,
      documentConfirmed: true,
      bloodGroupSkipped: true,
      allergiesSkipped: true,
      existingUserData: {
        firstName: "",
        lastName: "",
        dateOfBirth: "",
        gender: "",
        email: "",
        bloodGroup: "",
        allergies: [],
      },
    };

    ollamaClient.chat.mockResolvedValue({
      text: JSON.stringify({
        firstName: "Sarah",
        lastName: "Anderson",
        dateOfBirth: "01.01.1989",
        gender: "Female",
        email: "sarah@anderson.com",
      }),
      done_reason: "stop",
    });

    const result = await onboardingService.chat("Document Uploaded", [], mockState);

    expect(result.action).toBe("REGISTER_USER");
    expect(result.data).toEqual({
      firstName: "Sarah",
      lastName: "Anderson",
      dateOfBirth: "1989-01-01",
      gender: "female",
      email: "sarah@anderson.com",
      bloodGroup: null,
      allergies: [],
    });
  });

  it("Case 2: Document contains Name (Sarah Anderson) but missing DOB and Gender", async () => {
    const mockState = {
      isOnboardingCompleted: false,
      uploadedMedicalDocument: true,
      documentText: "Patient Name: Sarah Anderson",
      preferredLanguage: "en",
      flowMode: "UPLOAD",
      currentStep: "ASK_FIRST_NAME",
      documentExtracted: false,
      documentConfirmed: true,
      existingUserData: {
        firstName: "",
        lastName: "",
        dateOfBirth: "",
        gender: "",
        email: "",
        bloodGroup: "",
        allergies: [],
      },
    };

    ollamaClient.chat.mockResolvedValue({
      text: JSON.stringify({
        firstName: "Sarah",
        lastName: "Anderson",
      }),
      done_reason: "stop",
    });

    const result = await onboardingService.chat("Document Uploaded", [], mockState);

    expect(result.action).toBe("ASK_DOB");
    expect(result.message_en).toBe("What is your date of birth? (Example: 1989-01-01)");
  });

  it("Case 3: Document contains Name and DOB but missing Gender -> Must not guess gender", async () => {
    const mockState = {
      isOnboardingCompleted: false,
      uploadedMedicalDocument: true,
      documentText: "Patient Name: Sarah Anderson, DOB: 01.01.1989",
      preferredLanguage: "en",
      flowMode: "UPLOAD",
      currentStep: "ASK_FIRST_NAME",
      documentExtracted: false,
      documentConfirmed: true,
      existingUserData: {
        firstName: "",
        lastName: "",
        dateOfBirth: "",
        gender: "",
        email: "",
        bloodGroup: "",
        allergies: [],
      },
    };

    ollamaClient.chat.mockResolvedValue({
      text: JSON.stringify({
        firstName: "Sarah",
        lastName: "Anderson",
        dateOfBirth: "01.01.1989",
        gender: "", // No guessing
      }),
      done_reason: "stop",
    });

    const result = await onboardingService.chat("Document Uploaded", [], mockState);

    expect(result.action).toBe("ASK_GENDER");
    expect(result.message_en).toBe("What is your gender?");
    expect(result.options).toEqual([
      { label_en: "Male", label_gu: "પુરુષ", value: "male" },
      { label_en: "Female", label_gu: "સ્ત્રી", value: "female" },
    ]);
  });

  it("Case 4: Manual entry flow, no document provided", async () => {
    const mockState = {
      isOnboardingCompleted: false,
      uploadedMedicalDocument: false,
      documentText: "",
      preferredLanguage: "en",
      flowMode: null,
      currentStep: "ASK_UPLOAD_OR_SKIP",
      documentExtracted: false,
      existingUserData: {
        firstName: "",
        lastName: "",
        dateOfBirth: "",
        gender: "",
        email: "",
        bloodGroup: "",
        allergies: [],
      },
    };

    const result = await onboardingService.chat("MANUAL", [], mockState);

    expect(result.action).toBe("ASK_FIRST_NAME");
    expect(result.message_en).toBe("What is your first name?");
    expect(result.message_en).not.toBe("Please provide the information");
  });

  it("Should support language selection at start", async () => {
    const mockState = {
      isOnboardingCompleted: false,
      uploadedMedicalDocument: false,
      documentText: "",
      preferredLanguage: null,
      flowMode: null,
      documentExtracted: false,
      existingUserData: {
        firstName: "",
        lastName: "",
        dateOfBirth: "",
        gender: "",
        email: "",
        bloodGroup: "",
        allergies: [],
      },
    };

    const result = await onboardingService.chat("hello", [], mockState);

    expect(result.action).toBe("ASK_LANGUAGE");
    expect(result.options).toEqual([
      { label: "English / અંગ્રેજી", value: "english" },
      { label: "ગુજરાતી", value: "gujarati" },
    ]);
  });

  it("Should split full names correctly and handle single names", async () => {
    const { splitName } = require("../../../src/services/ai/chat/onboarding.service");
    expect(splitName("Sarah Anderson")).toEqual({ firstName: "Sarah", lastName: "Anderson" });
    expect(splitName("John Michael Smith")).toEqual({
      firstName: "John",
      lastName: "Michael Smith",
    });
    expect(splitName("Madonna")).toEqual({ firstName: "Madonna", lastName: "" });
  });

  it("Should normalize Date of Birth formats correctly", async () => {
    const { normalizeDOB } = require("../../../src/services/ai/chat/onboarding.service");
    expect(normalizeDOB("01.01.1989")).toBe("1989-01-01");
    expect(normalizeDOB("01/01/1989")).toBe("1989-01-01");
    expect(normalizeDOB("01-01-1989")).toBe("1989-01-01");
    expect(normalizeDOB("1989-01-01")).toBe("1989-01-01");
  });

  it("Should transition past ASK_UPLOAD_OR_SKIP and ASK_UPLOAD_DOCUMENT if document is already uploaded and extracted", async () => {
    const mockState = {
      currentStep: "ASK_UPLOAD_OR_SKIP",
      uploadedMedicalDocument: true,
      documentUploaded: true,
      documentExtracted: true,
      flowMode: null,
      preferredLanguage: "gujarati",
      existingUserData: {
        firstName: "Sarah",
        lastName: "Anderson",
        dateOfBirth: "2023-11-14",
        gender: null,
        bloodGroup: null,
        allergies: [],
        email: null,
      },
    };

    const result = await onboardingService.chat("UPLOAD", [], mockState);

    expect(result.action).not.toBe("ASK_UPLOAD_DOCUMENT");
    expect(result.action).not.toBe("ASK_UPLOAD_OR_SKIP");
    expect(result.state.currentStep).toBe("ASK_GENDER");
  });

  describe("New Refined Onboarding Flow Steps", () => {
    beforeEach(() => {
      const patientRepository = require("../../../src/repositories/patientRepository");
      patientRepository.updateById.mockClear();
    });

    it("Should map old step names (CONFIRM_DOCUMENT_DETAILS) to CONFIRM_DOCUMENT_OWNERSHIP via alias mapping", async () => {
      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_DETAILS",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
        },
      };

      const result = await onboardingService.chat("YES", [], mockState);
      expect(result.state.currentStep).not.toBe("CONFIRM_DOCUMENT_DETAILS");
    });

    it("Should handle CONFIRM_DOCUMENT_OWNERSHIP = 'NO' by discarding extracted details and reverting to MANUAL flow", async () => {
      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        documentUploaded: true,
        documentExtracted: true,
        documentText: "Extracted Patient Profile text",
        hasSocialData: true,
        socialData: {
          firstName: "GoogleFirst",
          lastName: "GoogleLast",
          email: "google@gmail.com",
          phoneNumber: "+1234567890",
        },
        documentData: {
          firstName: "DocFirst",
          lastName: "DocLast",
        },
        existingUserData: {
          firstName: "DocFirst",
          lastName: "DocLast",
          phoneNumber: "",
        },
      };

      const result = await onboardingService.chat("NO", [], mockState, "test-user-id");

      expect(result.state.flowMode).toBe("MANUAL");
      expect(result.state.documentUploaded).toBe(false);
      expect(result.state.documentExtracted).toBe(false);
      expect(result.state.existingUserData.firstName).toBe("GoogleFirst");
      expect(result.state.existingUserData.lastName).toBe("GoogleLast");

      const patientRepository = require("../../../src/repositories/patientRepository");
      expect(patientRepository.updateById).toHaveBeenCalled();
    });

    it("Should handle CONFIRM_DOCUMENT_OWNERSHIP = 'YES' and transition to RESOLVE_PROFILE_SOURCE if there are differences", async () => {
      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        documentUploaded: true,
        documentExtracted: true,
        hasSocialData: true,
        socialData: {
          firstName: "GoogleFirst",
          lastName: "GoogleLast",
        },
        documentData: {
          firstName: "DocFirst",
          lastName: "DocLast",
        },
        existingUserData: {
          firstName: "DocFirst",
          lastName: "DocLast",
        },
      };

      const result = await onboardingService.chat("YES", [], mockState);
      expect(result.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
    });

    it("Should handle CONFIRM_DOCUMENT_OWNERSHIP = 'YES' and highlight conflicting last names", async () => {
      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        documentUploaded: true,
        documentExtracted: true,
        hasSocialData: true,
        socialData: {
          firstName: "John",
          lastName: "Doe",
        },
        documentData: {
          firstName: "John",
          lastName: "Smith",
        },
        existingUserData: {
          firstName: "John",
          lastName: "Smith",
        },
      };

      const result = await onboardingService.chat("YES", [], mockState);
      expect(result.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");

      const lastNameField = result.fields.find((f) => f.key === "lastName");
      expect(lastNameField).toBeDefined();
      expect(lastNameField.isMismatch).toBe(true);
      expect(lastNameField.loginValue).toBe("Doe");
      expect(lastNameField.documentValue).toBe("Smith");
    });

    it("Should handle CONFIRM_DOCUMENT_OWNERSHIP = 'YES' and silently merge if no mismatch is present", async () => {
      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        documentUploaded: true,
        documentExtracted: true,
        hasSocialData: true,
        socialData: {
          firstName: "Sarah",
          lastName: "Anderson",
        },
        documentData: {
          firstName: "Sarah",
          lastName: "Anderson",
        },
        existingUserData: {
          firstName: "Sarah",
          lastName: "Anderson",
        },
      };

      const result = await onboardingService.chat("YES", [], mockState);
      expect(result.state.currentStep).toBe("ASK_DOB");
    });

    it("Should resolve profile conflict card with Use Social Login", async () => {
      const mockState = {
        currentStep: "RESOLVE_PROFILE_SOURCE",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        hasSocialData: true,
        socialData: {
          firstName: "SocialSarah",
          lastName: "SocialAnderson",
        },
        documentData: {
          firstName: "DocSarah",
          lastName: "DocAnderson",
        },
        existingUserData: {
          firstName: "DocSarah",
          lastName: "DocAnderson",
        },
      };

      const result = await onboardingService.chat(
        JSON.stringify({ source: "LOGIN" }),
        [],
        mockState,
      );
      expect(result.state.socialDataConfirmed).toBe(true);
      expect(result.state.existingUserData.firstName).toBe("SocialSarah");
      expect(result.state.existingUserData.lastName).toBe("SocialAnderson");
    });
  });
});
