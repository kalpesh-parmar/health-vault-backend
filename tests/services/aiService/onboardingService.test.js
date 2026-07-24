jest.mock("../../../src/configs/db", () => {
  const queryMock = {
    select: jest.fn(),
    from: jest.fn(),
    where: jest.fn(),
    orderBy: jest.fn(),
    limit: jest.fn(),
  };
  queryMock.select.mockReturnValue(queryMock);
  queryMock.from.mockReturnValue(queryMock);
  queryMock.where.mockReturnValue(queryMock);
  queryMock.orderBy.mockReturnValue(queryMock);
  queryMock.limit.mockReturnValue(queryMock);
  queryMock.then = (onFulfilled) => Promise.resolve([]).then(onFulfilled);
  return { db: queryMock };
});

const {
  onboardingService,
  splitName,
  normalizeDOB,
} = require("../../../src/services/ai/chat/onboarding.service");
const { ollamaClient } = require("../../../src/services/ai/clients/ollamaClient");
const patientRepository = require("../../../src/repositories/patientRepository");
const authProviderRepository = require("../../../src/repositories/authProviderRepository");
const medicationRepository = require("../../../src/repositories/medicationRepository");
const { db } = require("../../../src/configs/db");

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

jest.mock("../../../src/repositories/authProviderRepository", () => ({
  findByUserId: jest.fn().mockResolvedValue([]),
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
    expect(splitName("Sarah Anderson")).toEqual({ firstName: "Sarah", lastName: "Anderson" });
    expect(splitName("John Michael Smith")).toEqual({
      firstName: "John",
      lastName: "Michael Smith",
    });
    expect(splitName("Madonna")).toEqual({ firstName: "Madonna", lastName: "" });
  });

  it("Should normalize Date of Birth formats correctly", async () => {
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
      expect(result.state.profileConfirmed).toBe(true);
      expect(result.state.existingUserData.firstName).toBe("SocialSarah");
      expect(result.state.existingUserData.lastName).toBe("SocialAnderson");
    });

    it("Should auto-fill unverified email from document for phone-OTP user with no conflict", async () => {
      patientRepository.findById.mockResolvedValue({
        id: "otp-user-id",
        firstName: "OtpUser",
        lastName: "OtpLast",
        mobile: "9000000001",
        countryCode: "+91",
        email: null,
      });

      authProviderRepository.findByUserId.mockResolvedValue([{ provider: "mobile" }]);

      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        documentUploaded: true,
        documentExtracted: true,
        documentData: {
          firstName: "OtpUser",
          lastName: "OtpLast",
          phoneNumber: "+919000000002",
          email: "document@email.com",
        },
        existingUserData: {
          firstName: "OtpUser",
          lastName: "OtpLast",
        },
      };

      const result = await onboardingService.chat("YES", [], mockState, "otp-user-id");

      expect(result.state.currentStep).toBe("ASK_DOB");
      expect(result.state.existingUserData.email).toBe("document@email.com");
      expect(result.state.existingUserData.phoneNumber).toBe("+919000000001");
    });

    it("Should lock verified fields (phone + Google) when both exist", async () => {
      patientRepository.findById.mockResolvedValue({
        id: "multi-user-id",
        firstName: "MultiUser",
        lastName: "MultiLast",
        mobile: "9000000001",
        countryCode: "+91",
        email: "verified@gmail.com",
      });

      authProviderRepository.findByUserId.mockResolvedValue([
        { provider: "mobile" },
        { provider: "google" },
      ]);

      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        documentUploaded: true,
        documentExtracted: true,
        documentData: {
          firstName: "MultiUser",
          lastName: "MultiLast",
          phoneNumber: "+919000000002",
          email: "different@gmail.com",
        },
        existingUserData: {
          firstName: "MultiUser",
          lastName: "MultiLast",
        },
      };

      const result = await onboardingService.chat("YES", [], mockState, "multi-user-id");

      expect(result.state.currentStep).toBe("ASK_DOB");
      expect(result.state.existingUserData.email).toBe("verified@gmail.com");
      expect(result.state.existingUserData.phoneNumber).toBe("+919000000001");
    });

    it("Should lock verified fields from manual edits and exclude them from { edited }", async () => {
      patientRepository.findById.mockResolvedValue({
        id: "lock-user-id",
        firstName: "LockUser",
        lastName: "LockLast",
        mobile: "9000000001",
        countryCode: "+91",
        email: "verified@gmail.com",
      });

      authProviderRepository.findByUserId.mockResolvedValue([
        { provider: "mobile" },
        { provider: "google" },
      ]);

      const mockState = {
        currentStep: "RESOLVE_PROFILE_SOURCE",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        hasLoginData: true,
        loginData: {
          firstName: { value: "LockUser", verified: false },
          lastName: { value: "LockLast", verified: false },
          phoneNumber: { value: "+919000000001", verified: true },
          email: { value: "verified@gmail.com", verified: true },
        },
        documentData: {
          firstName: "DocUser",
          lastName: "DocLast",
          phoneNumber: "+919000000002",
          email: "different@gmail.com",
        },
        existingUserData: {
          firstName: "DocUser",
          lastName: "DocLast",
        },
      };

      const result = await onboardingService.chat(
        JSON.stringify({
          edited: {
            firstName: "NewFirstName",
            lastName: "NewLastName",
            phoneNumber: "+919999999999",
            email: "hacked@gmail.com",
          },
        }),
        [],
        mockState,
        "lock-user-id",
      );

      expect(result.state.profileConfirmed).toBe(true);
      expect(result.state.existingUserData.firstName).toBe("NewFirstName");
      expect(result.state.existingUserData.lastName).toBe("NewLastName");
      expect(result.state.existingUserData.email).toBe("verified@gmail.com");
      expect(result.state.existingUserData.phoneNumber).toBe("+919000000001");
    });

    it("Should route to CONFIRM mode and return all six fields in the payload when there are no mismatches", async () => {
      patientRepository.findById.mockResolvedValue({
        id: "confirm-user-id",
        firstName: "ConfirmUser",
        lastName: "ConfirmLast",
        mobile: "9000000001",
        countryCode: "+91",
        email: "confirm@gmail.com",
      });

      authProviderRepository.findByUserId.mockResolvedValue([{ provider: "mobile" }]);

      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        documentUploaded: true,
        documentExtracted: true,
        documentData: {
          firstName: "ConfirmUser",
          lastName: "ConfirmLast",
          phoneNumber: "+919000000001",
          email: "confirm@gmail.com",
        },
        existingUserData: {
          firstName: "ConfirmUser",
          lastName: "ConfirmLast",
        },
      };

      const result = await onboardingService.chat("YES", [], mockState, "confirm-user-id");

      expect(result.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.mode).toBe("CONFIRM");
      expect(result.fields).toHaveLength(6);
      expect(result.fields[0].key).toBe("firstName");
      expect(result.fields[5].key).toBe("email");
    });

    it("Should preserve non-conflicting/document-only fields when source choice is applied", async () => {
      patientRepository.findById.mockResolvedValue({
        id: "source-user-id",
        firstName: "SourceUser",
        lastName: "SourceLast",
        mobile: "9000000001",
        countryCode: "+91",
        email: "source@gmail.com",
      });

      authProviderRepository.findByUserId.mockResolvedValue([{ provider: "mobile" }]);

      const mockState = {
        currentStep: "RESOLVE_PROFILE_SOURCE",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        hasLoginData: true,
        loginData: {
          firstName: { value: "SourceUser", verified: false },
          lastName: { value: "SourceLast", verified: false },
          phoneNumber: { value: "+919000000001", verified: true },
          email: { value: "source@gmail.com", verified: true },
        },
        documentData: {
          firstName: "DocUser",
          lastName: "SourceLast",
          phoneNumber: "+919000000001",
          email: "source@gmail.com",
          gender: "female",
          dateOfBirth: "1995-05-15",
        },
        existingUserData: {
          firstName: "SourceUser",
          lastName: "SourceLast",
        },
      };

      // User picks source: "LOGIN" (which chooses "SourceUser" over "DocUser" for firstName conflict)
      const result = await onboardingService.chat(
        JSON.stringify({ source: "LOGIN" }),
        [],
        mockState,
        "source-user-id",
      );

      expect(result.state.profileConfirmed).toBe(true);
      expect(result.state.existingUserData.firstName).toBe("SourceUser");
      // Mismatched fields not selected are kept if empty on other side, but document-only fields are NOT wiped!
      expect(result.state.existingUserData.gender).toBe("female");
      expect(result.state.existingUserData.dateOfBirth).toBe("1995-05-15");
    });

    it("Should skip required fields that are pre-filled in existingUserData", async () => {
      patientRepository.findById.mockResolvedValue({
        id: "skip-user-id",
        firstName: "SkipUser",
        lastName: "SkipLast",
        mobile: "9000000001",
        countryCode: "+91",
        email: "skip@gmail.com",
      });

      authProviderRepository.findByUserId.mockResolvedValue([{ provider: "mobile" }]);

      const mockState = {
        currentStep: "RESOLVE_PROFILE_SOURCE",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        hasLoginData: true,
        loginData: {
          firstName: { value: "SkipUser", verified: false },
          lastName: { value: "SkipLast", verified: false },
          phoneNumber: { value: "+919000000001", verified: true },
          email: { value: "skip@gmail.com", verified: true },
        },
        documentData: {
          firstName: "SkipUser",
          lastName: "SkipLast",
          phoneNumber: "+919000000001",
          email: "skip@gmail.com",
        },
        existingUserData: {
          firstName: "SkipUser",
          lastName: "SkipLast",
          // Let's pre-fill dateOfBirth and gender
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };

      const result = await onboardingService.chat(
        JSON.stringify({ confirmed: true }),
        [],
        mockState,
        "skip-user-id",
      );

      expect(result.state.profileConfirmed).toBe(true);
      // Since firstName, lastName, phone, email, dob, gender are all present, next step should bypass them
      // Next step should proceed to blood group/allergies/medicines add step
      expect(result.state.currentStep).not.toBe("ASK_DOB");
      expect(result.state.currentStep).not.toBe("ASK_GENDER");
    });

    it("Should immediately advance flow on idempotency guard when profileConfirmed is already true", async () => {
      const mockState = {
        currentStep: "RESOLVE_PROFILE_SOURCE",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        profileConfirmed: true,
        existingUserData: {
          firstName: "IdempotentUser",
          lastName: "IdempotentLast",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };

      const result = await onboardingService.chat("YES", [], mockState, "idem-user-id");
      expect(result.state.currentStep).not.toBe("RESOLVE_PROFILE_SOURCE");
    });

    it("Should show CONFIRM mode when unverified fields are empty on login side but present on document side (auto-fill case)", async () => {
      patientRepository.findById.mockResolvedValue({
        id: "otp-confirm-user-id",
        firstName: null,
        lastName: null,
        mobile: "9000000001",
        countryCode: "+91",
        email: null,
      });

      authProviderRepository.findByUserId.mockResolvedValue([{ provider: "mobile" }]);

      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        documentUploaded: true,
        documentExtracted: true,
        documentData: {
          firstName: "URMILA",
          lastName: "HIPARPA",
          phoneNumber: "+919000000001",
          dateOfBirth: "1992-08-20",
          gender: "female",
        },
        existingUserData: {
          firstName: null,
          lastName: null,
        },
      };

      const result = await onboardingService.chat("YES", [], mockState, "otp-confirm-user-id");

      expect(result.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.mode).toBe("CONFIRM");
      expect(result.fields).toHaveLength(6);
      expect(result.loginProvider).toBe("mobile");

      // Verified phone is locked (verified: true, not editable)
      const phoneField = result.fields.find((f) => f.key === "phoneNumber");
      expect(phoneField.verified).toBe(true);
      expect(phoneField.editable).toBe(false);
      expect(phoneField.isMismatch).toBe(false);

      // Unverified email is empty on both sides -> no conflict, editable: true
      const emailField = result.fields.find((f) => f.key === "email");
      expect(emailField.verified).toBe(false);
      expect(emailField.editable).toBe(true);
      expect(emailField.isMismatch).toBe(false);

      // First name is populated from document and has value, no mismatch
      const firstNameField = result.fields.find((f) => f.key === "firstName");
      expect(firstNameField.value).toBe("URMILA");
      expect(firstNameField.isMismatch).toBe(false);
    });

    it("Should show CONFLICT mode when unverified fields differ on both sides", async () => {
      patientRepository.findById.mockResolvedValue({
        id: "conflict-otp-user-id",
        firstName: "OldName",
        lastName: null,
        mobile: "9000000001",
        countryCode: "+91",
        email: null,
      });

      authProviderRepository.findByUserId.mockResolvedValue([{ provider: "google" }]);

      const mockState = {
        currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        documentUploaded: true,
        documentExtracted: true,
        documentData: {
          firstName: "URMILA",
          lastName: "HIPARPA",
          phoneNumber: "+919000000001",
          dateOfBirth: "1992-08-20",
          gender: "female",
        },
        existingUserData: {
          firstName: "OldName",
          lastName: null,
        },
      };

      const result = await onboardingService.chat("YES", [], mockState, "conflict-otp-user-id");

      expect(result.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.mode).toBe("CONFLICT");
      expect(result.loginProvider).toBe("google");

      const firstNameField = result.fields.find((f) => f.key === "firstName");
      expect(firstNameField.isMismatch).toBe(true);
    });
  });

  describe("Medications Flow Integration", () => {
    beforeEach(() => {
      jest
        .spyOn(patientRepository, "findById")
        .mockResolvedValue({ id: "test-user-id", patientCode: "P-111" });
      jest
        .spyOn(medicationRepository, "insert")
        .mockResolvedValue({ id: "med-123", clientMedId: "doc_med_1" });
      jest
        .spyOn(medicationRepository, "bulkInsert")
        .mockResolvedValue([{ id: "med-123", clientMedId: "doc_med_0" }]);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("Case 5: document-found -> list -> add -> confirm -> store -> options", async () => {
      const mockState = {
        medicationFlowDone: false,
        medicationFlowStarted: false,
        currentStep: null,
        documentData: {
          doctorName: "Dr. Smith",
          medications: [
            { name: "Aspirin 150mg", dosage: "1 tablet", frequency: "once daily", type: "tablet" },
            { name: "Paracetamol", dosage: "", frequency: "twice daily", type: "tablet" },
          ],
        },
        existingUserData: {
          firstName: "Sarah",
          lastName: "Anderson",
          dateOfBirth: "1989-01-01",
          gender: "female",
        },
      };

      // Step 1: Start medication flow
      let result = await onboardingService.chat("hello", [], mockState, "test-user-id");
      expect(result.state.currentStep).toBe("REVIEW_MEDICINES_LIST");
      expect(result.action).toBe("REVIEW_MEDICINES_LIST");
      expect(result.medicines).toHaveLength(2);

      // Step 2: Submit selected medicines from list
      const selectedIds = [result.medicines[0].id, result.medicines[1].id];
      result = await onboardingService.chat(
        JSON.stringify({ selected: selectedIds }),
        [],
        result.state,
        "test-user-id",
      );

      expect(result.state.currentStep).toBe("ADD_MEDICINE");
      expect(result.action).toBe("ADD_MEDICINE");
      expect(result.medicine.name).toBe("Paracetamol");

      // Step 3: Complete Paracetamol details
      const addPayload = {
        clientMedId: result.medicine.client_med_id,
        medicine: {
          name: "Paracetamol",
          type: "TABLET",
          dose: { count: 1 },
          frequency: "TWICE",
        },
      };
      result = await onboardingService.chat(
        JSON.stringify(addPayload),
        [],
        result.state,
        "test-user-id",
      );
      expect(result.state.currentStep).toBe("CONFIRM_MEDICINE");
      expect(result.action).toBe("CONFIRM_MEDICINE");
      expect(result.summary.title).toBe("Paracetamol");

      // Step 4: Confirm Paracetamol (writes to DB)
      result = await onboardingService.chat(
        JSON.stringify({ confirmed: true }),
        [],
        result.state,
        "test-user-id",
      );
      expect(medicationRepository.insert).toHaveBeenCalled();

      expect(result.state.currentStep).toBe("CONFIRM_MEDICINE");
      expect(result.action).toBe("CONFIRM_MEDICINE");
      expect(result.summary.title).toBe("Confirm all medications");

      // Step 5: Confirm bulk list
      result = await onboardingService.chat(
        JSON.stringify({ confirmed: true }),
        [],
        result.state,
        "test-user-id",
      );
      expect(medicationRepository.bulkInsert).toHaveBeenCalled();
      expect(result.state.currentStep).toBe("MEDICINE_OPTIONS");
      expect(result.action).toBe("MEDICINE_OPTIONS");
    });

    it("Case 6: document-not-found -> options", async () => {
      const mockState = {
        medicationFlowDone: false,
        medicationFlowStarted: false,
        currentStep: null,
        documentData: null,
        existingUserData: {
          firstName: "Sarah",
          lastName: "Anderson",
          dateOfBirth: "1989-01-01",
          gender: "female",
        },
      };

      const result = await onboardingService.chat("hello", [], mockState, "test-user-id");
      expect(result.state.currentStep).toBe("MEDICINE_OPTIONS");
      expect(result.action).toBe("MEDICINE_OPTIONS");
    });

    it("Case 7: Uma Clinic prescription (Uma Clinic, Urmila)", async () => {
      db.then = (onFulfilled) =>
        Promise.resolve([
          {
            id: "doc-urmila",
            ocrStatus: "completed",
            structuredExtractedData: {
              medications: [
                {
                  name: "TAB. MBSON SL",
                  dosage: "",
                  frequency: "1-0-0",
                  type: "",
                  duration: "30 Days",
                  quantity: 30,
                },
                {
                  name: "Caldison D3",
                  dosage: "",
                  frequency: "1-0-0",
                  type: "",
                  duration: "4 Days",
                  quantity: 4,
                },
              ],
            },
          },
        ]).then(onFulfilled);

      const mockState = {
        medicationFlowDone: false,
        medicationFlowStarted: false,
        currentStep: null,
        documentId: "doc-urmila",
        flowMode: "UPLOAD",
        existingUserData: {
          firstName: "Urmila",
          lastName: "Shah",
          dateOfBirth: "1992-08-20",
          gender: "female",
        },
      };

      // Step 1: Start medication flow
      let result = await onboardingService.chat("hello", [], mockState, "test-user-id");
      expect(result.state.currentStep).toBe("REVIEW_MEDICINES_LIST");
      expect(result.action).toBe("REVIEW_MEDICINES_LIST");
      expect(result.medicines).toHaveLength(2);

      // Verify "MBSON SL" normalization
      const mbson = result.medicines[0];
      expect(mbson.name).toBe("MBSON SL");
      expect(mbson.type).toBe("TABLET");
      expect(mbson.dose.count).toBe(1);
      expect(mbson.frequency).toBe("ONCE");
      expect(mbson.duration).toBe("30 Days");
      expect(mbson.total_quantity).toBe(30);
      expect(mbson.medicationSchedule.times).toEqual(["08:00"]);
      expect(mbson.medicationSchedule.reminderTimes).toEqual(["08:00"]);

      // Verify "Caldison D3" normalization
      const caldison = result.medicines[1];
      expect(caldison.name).toBe("Caldison D3");
      expect(caldison.type).toBe("TABLET");
      expect(caldison.dose.count).toBe(1);
      expect(caldison.frequency).toBe("ONCE");
      expect(caldison.duration).toBe("4 Days");
      expect(caldison.total_quantity).toBe(4);
      expect(caldison.medicationSchedule.times).toEqual(["08:00"]);
      expect(caldison.medicationSchedule.reminderTimes).toEqual(["08:00"]);
    });
  });
});
