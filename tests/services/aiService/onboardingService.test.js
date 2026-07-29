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
  normalizeGenderLocally,
  isValidGender,
  extractFieldFromMessage,
} = require("../../../src/services/ai/chat/onboarding.service");
const { ollamaClient } = require("../../../src/services/ai/clients/ollamaClient");
const patientRepository = require("../../../src/repositories/patientRepository");
const authProviderRepository = require("../../../src/repositories/authProviderRepository");

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

describe("OnboardingService Re-sequenced Target Flow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("Path 1: UPLOAD 'Yes' with conflict -> required Q&A -> CONFLICT card -> confirm -> optional Q&A -> medication -> REGISTER_USER", async () => {
    patientRepository.findById.mockResolvedValue({
      id: "path1-user",
      firstName: "LoginFirstName",
      lastName: "LoginLastName",
      email: "login@test.com",
    });
    authProviderRepository.findByUserId.mockResolvedValue([{ provider: "google" }]);

    const mockState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
      documentUploaded: true,
      documentExtracted: true,
      documentConfirmed: true,
      useDocumentData: true,
      documentData: {
        firstName: "DocFirstName", // Mismatch with LoginFirstName
        lastName: "DocLastName", // Mismatch with LoginLastName
      },
      loginData: {
        firstName: { value: "LoginFirstName", verified: false },
        lastName: { value: "LoginLastName", verified: false },
        email: { value: "login@test.com", verified: true },
      },
      existingUserData: {
        firstName: "DocFirstName",
        lastName: "DocLastName",
      },
    };

    // Step 1: User says YES to document ownership -> Missing required Q&A (dateOfBirth / gender) is asked BEFORE card
    let result = await onboardingService.chat("YES", [], mockState, "path1-user");
    expect(result.action).toBe("ASK_DOB");

    // Step 2: Answer DOB
    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "1990-01-01" }) });
    result = await onboardingService.chat("1990-01-01", [], result.state, "path1-user");
    expect(result.action).toBe("ASK_GENDER");

    // Step 3: Answer Gender -> All required Q&A collected -> CONFLICT Card triggers ONCE
    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "male" }) });
    result = await onboardingService.chat("male", [], result.state, "path1-user");
    expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
    expect(result.mode).toBe("CONFLICT");

    // Verify card payload includes Q&A answers and required fields, but NOT optional fields
    const keysOnCard = result.fields.map((f) => f.key);
    expect(keysOnCard).toContain("firstName");
    expect(keysOnCard).toContain("dateOfBirth");
    expect(keysOnCard).not.toContain("bloodGroup");

    // Step 4: User resolves conflict by selecting "LOGIN"
    result = await onboardingService.chat(
      JSON.stringify({ source: "LOGIN" }),
      [],
      result.state,
      "path1-user",
    );
    expect(result.state.profileConfirmed).toBe(true);

    // Step 5: AFTER card confirmation -> Optional Q&A (ASK_BLOOD_GROUP) runs
    expect(result.action).toBe("ASK_BLOOD_GROUP");

    // Step 6: Skip Blood Group -> ASK_ALLERGIES
    result = await onboardingService.chat("SKIP", [], result.state, "path1-user");
    expect(result.action).toBe("ASK_ALLERGIES");

    // Step 7: Skip Allergies -> Medication flow (or REGISTER_USER)
    result = await onboardingService.chat("SKIP", [], result.state, "path1-user");
    expect(result.action).toBe("MEDICINE_OPTIONS");
  });

  it("Path 2: UPLOAD 'No' -> document excluded (useDocumentData = false) -> required Q&A -> CONFIRM card -> confirm -> optional Q&A -> complete", async () => {
    const mockState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      currentStep: "CONFIRM_DOCUMENT_OWNERSHIP",
      documentUploaded: true,
      documentExtracted: true,
      documentData: {
        firstName: "DocOnlyFirstName",
        lastName: "DocOnlyLastName",
      },
      loginData: {
        firstName: { value: "LoginUser", verified: false },
        lastName: { value: "LoginLast", verified: false },
      },
      existingUserData: {
        firstName: "DocOnlyFirstName",
        lastName: "DocOnlyLastName",
      },
    };

    // User says NO to document ownership -> useDocumentData set to false -> revert to MANUAL
    let result = await onboardingService.chat("NO", [], mockState, "path2-user");
    expect(result.state.useDocumentData).toBe(false);

    // Missing DOB & Gender are asked via Q&A
    expect(result.action).toBe("ASK_DOB");

    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "1995-05-15" }) });
    result = await onboardingService.chat("1995-05-15", [], result.state, "path2-user");
    expect(result.action).toBe("ASK_GENDER");

    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "female" }) });
    result = await onboardingService.chat("female", [], result.state, "path2-user");

    // Card triggers in CONFIRM mode because useDocumentData === false (no document conflict)
    expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
    expect(result.mode).toBe("CONFIRM");

    // Confirm card
    result = await onboardingService.chat(
      JSON.stringify({ confirmed: true }),
      [],
      result.state,
      "path2-user",
    );
    expect(result.state.profileConfirmed).toBe(true);

    // Optional Q&A runs post-card
    expect(result.action).toBe("ASK_BLOOD_GROUP");
  });

  it("Path 3: Mobile OTP -> required Q&A -> CONFIRM card -> confirm -> optional Q&A -> complete", async () => {
    patientRepository.findById.mockResolvedValue({
      id: "otp-user",
      mobile: "9876543210",
      countryCode: "+91",
    });
    authProviderRepository.findByUserId.mockResolvedValue([{ provider: "mobile" }]);

    const mockState = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      currentStep: "ASK_FIRST_NAME",
      loginData: {
        phoneNumber: { value: "+919876543210", verified: true },
      },
      existingUserData: {},
    };

    // User provides First Name
    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "John" }) });
    let result = await onboardingService.chat("John", [], mockState, "otp-user");
    expect(result.action).toBe("ASK_LAST_NAME");

    // Last Name
    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "Doe" }) });
    result = await onboardingService.chat("Doe", [], result.state, "otp-user");
    expect(result.action).toBe("ASK_DOB");

    // DOB
    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "1988-08-08" }) });
    result = await onboardingService.chat("1988-08-08", [], result.state, "otp-user");
    expect(result.action).toBe("ASK_GENDER");

    // Gender
    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "male" }) });
    result = await onboardingService.chat("male", [], result.state, "otp-user");

    // CONFIRM mode card
    expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
    expect(result.mode).toBe("CONFIRM");

    // Confirm Card
    result = await onboardingService.chat(
      JSON.stringify({ confirmed: true }),
      [],
      result.state,
      "otp-user",
    );
    expect(result.state.profileConfirmed).toBe(true);

    // Optional Q&A
    expect(result.action).toBe("ASK_BLOOD_GROUP");
  });

  it("Path 4: MANUAL + Google Login (name present) -> skip name Q&A, ask DOB+Gender -> CONFIRM card -> optional Q&A", async () => {
    const mockState = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      loginData: {
        firstName: { value: "GoogleUser", verified: false },
        lastName: { value: "GoogleLast", verified: false },
        email: { value: "user@gmail.com", verified: true },
      },
      existingUserData: {},
    };

    // First call: names are already present in loginData, so it skips names and asks ASK_DOB directly
    let result = await onboardingService.chat("hello", [], mockState, "google-user");
    expect(result.action).toBe("ASK_DOB");

    // Answer DOB
    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "1992-02-02" }) });
    result = await onboardingService.chat("1992-02-02", [], result.state, "google-user");
    expect(result.action).toBe("ASK_GENDER");

    // Answer Gender
    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "female" }) });
    result = await onboardingService.chat("female", [], result.state, "google-user");
    expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
    expect(result.mode).toBe("CONFIRM");
  });

  it("Guard: Once profileConfirmed === true, REQUIRED Q&A and RESOLVE_PROFILE_SOURCE card are never returned again", async () => {
    const mockState = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      profileConfirmed: true,
      existingUserData: {
        firstName: null, // missing required, but profileConfirmed is TRUE
        lastName: null,
      },
    };

    const result = await onboardingService.chat("hello", [], mockState, "guard-user");
    expect(result.action).not.toBe("ASK_FIRST_NAME");
    expect(result.action).not.toBe("ASK_LAST_NAME");
    expect(result.action).not.toBe("RESOLVE_PROFILE_SOURCE");
    expect(result.action).toBe("ASK_BLOOD_GROUP");
  });

  it("mergeAndApplyProfile: Choosing a source that lacks gender/DOB does NOT null out Q&A-collected required values", async () => {
    const mockState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      currentStep: "RESOLVE_PROFILE_SOURCE",
      loginData: {
        firstName: { value: "LoginName", verified: false },
        lastName: { value: "LoginLast", verified: false },
        gender: { value: null, verified: false },
        dateOfBirth: { value: null, verified: false },
      },
      documentData: {
        firstName: "DocName",
        lastName: "DocLast",
        gender: null,
        dateOfBirth: null,
      },
      existingUserData: {
        firstName: "LoginName",
        lastName: "LoginLast",
        dateOfBirth: "1990-01-01", // Collected via Q&A previously
        gender: "male", // Collected via Q&A previously
      },
    };

    const result = await onboardingService.chat(
      JSON.stringify({ source: "LOGIN" }),
      [],
      mockState,
      "preserve-user",
    );

    expect(result.state.existingUserData.dateOfBirth).toBe("1990-01-01");
    expect(result.state.existingUserData.gender).toBe("male");
  });

  it("Resume Test 1: Resume after profileConfirmed === true -> no required ASK_* and no card re-shown; continues at optional Q&A", async () => {
    const mockState = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      profileConfirmed: true,
      existingUserData: {
        firstName: "ResumeUser",
        lastName: "ResumeLast",
        dateOfBirth: "1991-11-11",
        gender: "female",
      },
    };

    const result = await onboardingService.chat("hello", [], mockState, "resume-user-1");

    expect(result.action).not.toBe("ASK_FIRST_NAME");
    expect(result.action).not.toBe("RESOLVE_PROFILE_SOURCE");
    expect(result.action).toBe("ASK_BLOOD_GROUP");
  });

  it("Resume Test 2: bloodGroupSkipped / allergiesSkipped persist across resume -> optional questions not re-asked", async () => {
    const mockState = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      profileConfirmed: true,
      bloodGroupSkipped: true,
      allergiesSkipped: true,
      medicationFlowDone: true,
      existingUserData: {
        firstName: "SkipUser",
        lastName: "SkipLast",
        dateOfBirth: "1991-11-11",
        gender: "female",
      },
    };

    const result = await onboardingService.chat("hello", [], mockState, "resume-user-2");

    expect(result.action).not.toBe("ASK_BLOOD_GROUP");
    expect(result.action).not.toBe("ASK_ALLERGIES");
    expect(result.action).toBe("REGISTER_USER");
  });

  it("Should build RESOLVE_PROFILE_SOURCE payload without error in both CONFLICT and CONFIRM modes", async () => {
    patientRepository.findById.mockResolvedValue({
      id: "repro-user",
      firstName: "Kalpesh",
      lastName: "Parmar",
      email: "kalpesh@test.com",
    });
    authProviderRepository.findByUserId.mockResolvedValue([{ provider: "google" }]);

    // CONFLICT mode repro state: UPLOAD path, "Yes" to ownership, conflicting names (Kalpesh/Shraddha, Parmar/Chauhan), gender answered
    const conflictState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      currentStep: "ASK_GENDER",
      documentUploaded: true,
      documentExtracted: true,
      documentConfirmed: true,
      useDocumentData: true,
      documentData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        gender: "female",
        dateOfBirth: "1992-05-15",
      },
      loginData: {
        firstName: { value: "Kalpesh", verified: false },
        lastName: { value: "Parmar", verified: false },
        email: { value: "kalpesh@test.com", verified: true },
      },
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "1992-05-15",
      },
    };

    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "female" }) });
    const conflictResult = await onboardingService.chat("female", [], conflictState, "repro-user");

    expect(conflictResult.action).toBe("RESOLVE_PROFILE_SOURCE");
    expect(conflictResult.mode).toBe("CONFLICT");
    expect(conflictResult.fields).toHaveLength(6);

    const fnField = conflictResult.fields.find((f) => f.key === "firstName");
    expect(fnField.isMismatch).toBe(true);
    expect(fnField.loginValue).toBe("Kalpesh");
    expect(fnField.documentValue).toBe("Shraddha");
    expect(fnField.editable).toBe(true);

    const emailField = conflictResult.fields.find((f) => f.key === "email");
    expect(emailField.verified).toBe(true);
    expect(emailField.editable).toBe(false);

    // CONFIRM mode check
    const confirmState = {
      ...conflictState,
      documentData: {
        firstName: "Kalpesh",
        lastName: "Parmar",
      },
    };
    ollamaClient.chat.mockResolvedValueOnce({ text: JSON.stringify({ value: "male" }) });
    const confirmResult = await onboardingService.chat("male", [], confirmState, "repro-user");

    expect(confirmResult.action).toBe("RESOLVE_PROFILE_SOURCE");
    expect(confirmResult.mode).toBe("CONFIRM");
    expect(confirmResult.fields.every((f) => f.isMismatch === false)).toBe(true);
  });

  describe("Fast-Path & Latency Optimization Tests", () => {
    it("Should normalize gender locally using existing i18n dictionaries for English, Gujarati, and Tamil tokens", () => {
      expect(normalizeGenderLocally("female")).toBe("female");
      expect(normalizeGenderLocally("male")).toBe("male");
      expect(normalizeGenderLocally("other")).toBe("other");
      expect(normalizeGenderLocally("M")).toBe("male");
      expect(normalizeGenderLocally("f")).toBe("female");
      expect(normalizeGenderLocally("woman")).toBe("female");
      expect(normalizeGenderLocally("boy")).toBe("male");

      // Gujarati from i18n
      expect(normalizeGenderLocally("સ્ત્રી")).toBe("female");
      expect(normalizeGenderLocally("પુરુષ")).toBe("male");
      expect(normalizeGenderLocally("અન્ય")).toBe("other");

      // Tamil from i18n
      expect(normalizeGenderLocally("பெண்")).toBe("female");
      expect(normalizeGenderLocally("ஆண்")).toBe("male");
      expect(normalizeGenderLocally("மற்றவை")).toBe("other");

      // Unmapped fallback
      expect(normalizeGenderLocally("not sure yet")).toBeNull();
    });

    it("Should accept male, female, and other in isValidGender", () => {
      expect(isValidGender("male")).toBe(true);
      expect(isValidGender("female")).toBe(true);
      expect(isValidGender("other")).toBe(true);
      expect(isValidGender("unknown")).toBe(false);
    });

    it("Fast-Path: Should extract closed-choice fields locally without calling ollamaClient.chat", async () => {
      ollamaClient.chat.mockClear();

      const genRes = await extractFieldFromMessage("gender", "woman", "english");
      expect(genRes).toBe("female");
      expect(ollamaClient.chat).not.toHaveBeenCalled();

      const gujGenRes = await extractFieldFromMessage("gender", "સ્ત્રી", "gujarati");
      expect(gujGenRes).toBe("female");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    it("Fallback: Should call LLM path when input is unrecognized free text and handle timeout gracefully", async () => {
      ollamaClient.chat.mockClear();
      ollamaClient.chat.mockRejectedValueOnce(new Error("Request timed out after 8000ms"));

      const res = await extractFieldFromMessage("gender", "i am not sure yet", "english");
      expect(ollamaClient.chat).toHaveBeenCalled();
      expect(res).toBeNull();
    });

    it("Latency Guard: Answering ASK_GENDER with recognized input should transition to RESOLVE_PROFILE_SOURCE with ZERO ollamaClient.chat calls", async () => {
      ollamaClient.chat.mockClear();
      patientRepository.findById.mockResolvedValue({
        id: "fast-user",
        firstName: "Kalpesh",
        lastName: "Parmar",
      });
      authProviderRepository.findByUserId.mockResolvedValue([{ provider: "google" }]);

      const mockState = {
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        currentStep: "ASK_GENDER",
        documentUploaded: true,
        documentExtracted: true,
        documentConfirmed: true,
        useDocumentData: true,
        documentData: {
          firstName: "Shraddha",
          lastName: "Chauhan",
        },
        loginData: {
          firstName: { value: "Kalpesh", verified: false },
          lastName: { value: "Parmar", verified: false },
        },
        existingUserData: {
          firstName: "Shraddha",
          lastName: "Chauhan",
          dateOfBirth: "1990-01-01",
        },
      };

      const result = await onboardingService.chat("female", [], mockState, "fast-user");

      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.state.existingUserData.gender).toBe("female");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
    it("Should extract flowMode deterministically without calling LLM for DOCUMENT_UPLOADED, UPLOAD, MANUAL, SKIP", async () => {
      ollamaClient.chat.mockClear();

      expect(await extractFieldFromMessage("flowMode", "DOCUMENT_UPLOADED", "english")).toBe(
        "UPLOAD",
      );
      expect(await extractFieldFromMessage("flowMode", "UPLOAD", "english")).toBe("UPLOAD");
      expect(await extractFieldFromMessage("flowMode", "MANUAL", "english")).toBe("MANUAL");
      expect(await extractFieldFromMessage("flowMode", "SKIP", "english")).toBe("MANUAL");
      expect(await extractFieldFromMessage("flowMode", "MANUAL_ENTRY", "english")).toBe("MANUAL");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    it("Should extract medicine closed-choice fields without calling LLM", async () => {
      ollamaClient.chat.mockClear();

      expect(await extractFieldFromMessage("medicationType", "TABLET", "english")).toBe("TABLET");
      expect(await extractFieldFromMessage("frequency", "ONCE_DAILY", "english")).toBe(
        "ONCE_DAILY",
      );
      expect(await extractFieldFromMessage("foodFrequency", "BEFORE_FOOD", "english")).toBe(
        "BEFORE_FOOD",
      );
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    it("Should process DOCUMENT_UPLOADED in ASK_UPLOAD_OR_SKIP step with zero LLM calls and advance currentStep", async () => {
      ollamaClient.chat.mockClear();
      patientRepository.findById.mockResolvedValue({ id: "upload-user" });
      authProviderRepository.findByUserId.mockResolvedValue([{ provider: "google" }]);

      const mockState = {
        preferredLanguage: "english",
        currentStep: "ASK_UPLOAD_OR_SKIP",
        documentUploaded: true,
        documentExtracted: true,
        documentConfirmed: true,
        useDocumentData: true,
        loginData: {
          firstName: { value: "Kalpesh", verified: false },
          lastName: { value: "Parmar", verified: false },
        },
        documentData: {
          firstName: "Shraddha",
          lastName: "Chauhan",
        },
      };

      const result = await onboardingService.chat(
        "DOCUMENT_UPLOADED",
        [],
        mockState,
        "upload-user",
      );

      expect(result.state.flowMode).toBe("UPLOAD");
      expect(result.state.currentStep).not.toBe("ASK_UPLOAD_OR_SKIP");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });

    it("Fallback: Should set state.flowMode to UPLOAD safely when LLM times out if documentUploaded === true", async () => {
      ollamaClient.chat.mockClear();
      ollamaClient.chat.mockRejectedValueOnce(new Error("Request timed out after 8000ms"));

      const mockState = {
        preferredLanguage: "english",
        currentStep: "ASK_UPLOAD_OR_SKIP",
        documentUploaded: true,
      };

      const result = await onboardingService.chat(
        "unknown option string",
        [],
        mockState,
        "fallback-user",
      );

      expect(result.state.flowMode).toBe("UPLOAD");
      expect(result.state.currentStep).not.toBe("ASK_UPLOAD_OR_SKIP");
    });

    it("Should extract dateOfBirth deterministically for ISO, DMY, and Gujarati/Devanagari numerals without calling LLM", async () => {
      ollamaClient.chat.mockClear();
      // ISO format
      expect(await extractFieldFromMessage("dateOfBirth", "1994-05-16", "english")).toBe(
        "1994-05-16",
      );
      // DMY formats
      expect(await extractFieldFromMessage("dateOfBirth", "16/05/1994", "english")).toBe(
        "1994-05-16",
      );
      expect(await extractFieldFromMessage("dateOfBirth", "16-05-1994", "english")).toBe(
        "1994-05-16",
      );
      expect(await extractFieldFromMessage("dateOfBirth", "16.05.1994", "english")).toBe(
        "1994-05-16",
      );
      // Localized numerals (Gujarati & Devanagari)
      expect(await extractFieldFromMessage("dateOfBirth", "૧૬-૦૫-૧૯૯૪", "gujarati")).toBe(
        "1994-05-16",
      );
      expect(await extractFieldFromMessage("dateOfBirth", "१६-०५-१९९४", "hindi")).toBe(
        "1994-05-16",
      );
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
    it("DOB Fallback Hardening: free text falls through to LLM path; on timeout invalid raw text is NOT stored", async () => {
      ollamaClient.chat.mockClear();
      ollamaClient.chat.mockRejectedValueOnce(new Error("Request timed out after 8000ms"));
      const res = await extractFieldFromMessage("dateOfBirth", "invalid garbage string", "english");
      expect(ollamaClient.chat).toHaveBeenCalled();
      expect(res).toBeNull(); // Must NOT return unvalidated raw garbage
    });
    it("Latency Guard: Answering ASK_DOB with valid date advances to ASK_GENDER with ZERO LLM calls", async () => {
      ollamaClient.chat.mockClear();
      patientRepository.findById.mockResolvedValue({ id: "dob-user" });
      authProviderRepository.findByUserId.mockResolvedValue([{ provider: "google" }]);
      const mockState = {
        preferredLanguage: "english",
        currentStep: "ASK_DOB",
        flowMode: "MANUAL",
        existingUserData: {
          firstName: "Shraddha",
          lastName: "Chauhan",
        },
      };
      const result = await onboardingService.chat("1994-05-16", [], mockState, "dob-user");
      expect(result.state.existingUserData.dateOfBirth).toBe("1994-05-16");
      expect(result.state.currentStep).toBe("ASK_GENDER");
      expect(ollamaClient.chat).not.toHaveBeenCalled();
    });
  });

  it("Should support name splitting and DOB normalization utilities", () => {
    expect(splitName("Sarah Anderson")).toEqual({ firstName: "Sarah", lastName: "Anderson" });
    expect(normalizeDOB("01.01.1989")).toBe("1989-01-01");
  });

  describe("Profile Confirmation Edit & Save Flow", () => {
    it("Change 1 & 2: { edited } updates state, keeps profileConfirmed=false, re-shows CONFIRM card (mode CONFIRM)", async () => {
      const mockState = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        currentStep: "RESOLVE_PROFILE_SOURCE",
        profileConfirmed: false,
        loginData: {
          firstName: { value: "JohnLogin", verified: false },
          lastName: { value: "DoeLogin", verified: false },
        },
        existingUserData: {
          firstName: "JohnLogin",
          lastName: "DoeLogin",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };

      const editedPayload = JSON.stringify({
        edited: {
          firstName: "JohnEdited",
          lastName: "DoeEdited",
        },
      });

      const result = await onboardingService.chat(editedPayload, [], mockState, "test-user");

      expect(result.state.profileConfirmed).toBe(false);
      expect(result.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.mode).toBe("CONFIRM");
      expect(result.state.existingUserData.firstName).toBe("JohnEdited");
      expect(result.state.existingUserData.lastName).toBe("DoeEdited");

      const firstNameField = result.fields.find((f) => f.key === "firstName");
      expect(firstNameField.value).toBe("JohnEdited");
    });

    it("Change 2: CONFLICT card -> edit -> re-render forces single CONFIRM card (mode CONFIRM)", async () => {
      const mockState = {
        preferredLanguage: "english",
        flowMode: "UPLOAD",
        currentStep: "RESOLVE_PROFILE_SOURCE",
        profileConfirmed: false,
        documentConfirmed: true,
        useDocumentData: true,
        loginData: {
          firstName: { value: "LoginName", verified: false },
        },
        documentData: {
          firstName: "DocName",
        },
        existingUserData: {
          firstName: "DocName",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };

      const editedPayload = JSON.stringify({
        edited: { firstName: "ReconciledName" },
      });

      const result = await onboardingService.chat(editedPayload, [], mockState, "test-user");

      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.mode).toBe("CONFIRM");
      expect(result.state.profileManuallyEdited).toBe(true);
    });

    it("Change 3: Partial edit preserves unedited fields", async () => {
      const mockState = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        currentStep: "RESOLVE_PROFILE_SOURCE",
        profileConfirmed: false,
        existingUserData: {
          firstName: "OriginalFirst",
          lastName: "OriginalLast",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };

      const editedPayload = JSON.stringify({
        edited: { firstName: "NewFirstOnly" },
      });

      const result = await onboardingService.chat(editedPayload, [], mockState, "test-user");

      expect(result.state.existingUserData.firstName).toBe("NewFirstOnly");
      expect(result.state.existingUserData.lastName).toBe("OriginalLast");
      expect(result.state.existingUserData.dateOfBirth).toBe("1990-01-01");
    });

    it("Change 4: Invalid edited required field re-shows card with clarification, profileConfirmed=false, no advance", async () => {
      const mockState = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        currentStep: "RESOLVE_PROFILE_SOURCE",
        profileConfirmed: false,
        existingUserData: {
          firstName: "ValidFirst",
          lastName: "ValidLast",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };

      const invalidEditedPayload = JSON.stringify({
        edited: { gender: "invalid_gender_val" },
      });

      const result = await onboardingService.chat(invalidEditedPayload, [], mockState, "test-user");

      expect(result.state.profileConfirmed).toBe(false);
      expect(result.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.state.existingUserData.gender).toBe("male");
      expect(result.state.stepClarificationNeeded).toBe(true);
    });

    it("Change 4b: Defense-in-depth normalizes edited gender (e.g. 'Male', 'પુરુષ', 'स्त्री') and DOB ('15/05/1995') to canonical values", async () => {
      const mockState = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        currentStep: "RESOLVE_PROFILE_SOURCE",
        profileConfirmed: false,
        existingUserData: {
          firstName: "ValidFirst",
          lastName: "ValidLast",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };

      const editedPayload = JSON.stringify({
        edited: { gender: "Male", dateOfBirth: "15/05/1995" },
      });

      const result = await onboardingService.chat(editedPayload, [], mockState, "test-user");

      expect(result.state.profileConfirmed).toBe(false);
      expect(result.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.state.existingUserData.gender).toBe("male");
      expect(result.state.existingUserData.dateOfBirth).toBe("1995-05-15");
    });

    it("Change 5: Unrecognized message on RESOLVE_PROFILE_SOURCE re-shows card once with no side effects (idempotent)", async () => {
      const mockState = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        currentStep: "RESOLVE_PROFILE_SOURCE",
        profileConfirmed: false,
        existingUserData: {
          firstName: "John",
          lastName: "Doe",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };

      const result = await onboardingService.chat(
        "random unknown text message",
        [],
        mockState,
        "test-user",
      );

      expect(result.state.profileConfirmed).toBe(false);
      expect(result.state.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.action).toBe("RESOLVE_PROFILE_SOURCE");
      expect(result.state.existingUserData.firstName).toBe("John");
    });

    it("Change 6 & 7: { confirmed: true } preserves edited values and advances to next step without re-asking questions", async () => {
      const mockState = {
        preferredLanguage: "english",
        flowMode: "MANUAL",
        currentStep: "RESOLVE_PROFILE_SOURCE",
        profileConfirmed: false,
        profileManuallyEdited: true,
        existingUserData: {
          firstName: "EditedFirst",
          lastName: "EditedLast",
          dateOfBirth: "1990-01-01",
          gender: "male",
        },
      };

      const confirmPayload = JSON.stringify({ confirmed: true });

      const result = await onboardingService.chat(confirmPayload, [], mockState, "test-user");

      expect(result.state.profileConfirmed).toBe(true);
      expect(result.state.existingUserData.firstName).toBe("EditedFirst");
      expect(result.state.existingUserData.lastName).toBe("EditedLast");
      expect(result.action).toBe("ASK_BLOOD_GROUP");
    });
  });
});
