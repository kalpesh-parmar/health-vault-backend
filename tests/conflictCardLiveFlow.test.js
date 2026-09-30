const ocrService = require("../src/services/ocr.service");
const patientRepository = require("../src/repositories/patientRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
const authProviderRepository = require("../src/repositories/authProviderRepository");
const { chatService } = require("../src/services/ai/chat/chat.service");

jest.setTimeout(30000);

describe("Phase 15: Conflict Card Live Flow Mode & Metadata Tests", () => {
  let dbStates = {};

  beforeEach(() => {
    jest.restoreAllMocks();
    dbStates = {};

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-live-conflict",
      firstName: "John",
      lastName: "Doe",
      gender: "male",
      onboardingCompleted: false,
    });
    jest.spyOn(patientRepository, "updateById").mockImplementation(async (id, data) => {
      return { id, ...data };
    });
    jest
      .spyOn(authProviderRepository, "findByUserId")
      .mockResolvedValue([{ provider: "microsoft" }]);
    jest.spyOn(userOnboardingRepository, "findByUserId").mockImplementation(async (userId) => {
      return { data: dbStates[userId] || {} };
    });
    jest
      .spyOn(userOnboardingRepository, "updateByUserId")
      .mockImplementation(async (userId, payload) => {
        dbStates[userId] = payload.data;
        return {};
      });
    jest.spyOn(chatService, "createOnboardingSession").mockResolvedValue({ id: "session-live-1" });
    jest
      .spyOn(chatService, "getOrCreateCanonicalSession")
      .mockResolvedValue({ id: "session-live-1" });
    jest
      .spyOn(chatService, "appendChatMessage")
      .mockResolvedValue({ id: "msg-live-1", createdAt: new Date() });
  });

  test("1. Live response for social login + conflicting document upload preserves mode: 'CONFLICT', loginProvider, and sourceComparison", async () => {
    const initialState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      loginProvider: "microsoft",
      hasSocialData: true,
      hasLoginData: true,
      documentUploaded: true,
      documentConfirmed: true,
      chatSessionId: "session-live-1",
      socialData: {
        firstName: "John",
        lastName: "Doe",
      },
      loginData: {
        firstName: { value: "John" },
        lastName: { value: "Doe" },
      },
      documentData: {
        firstName: "Johnny",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "male",
      },
      existingUserData: {
        firstName: "Johnny",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "male",
      },
      profileConfirmed: false,
      currentStep: "ASK_UPLOAD_DOCUMENT",
    };
    dbStates["user-live-conflict"] = initialState;

    const res = await ocrService.onboardingChat("user-live-conflict", {
      message: "DOCUMENT_UPLOADED",
      state: initialState,
    });

    expect(res.actionType).toBe("RESOLVE_PROFILE_SOURCE");
    expect(res.mode).toBe("CONFLICT");
    expect(res.loginProvider).toBe("microsoft");
    expect(res.sourceComparison).toBe("DOCUMENT_VS_LOGIN");
    expect(Array.isArray(res.fields)).toBe(true);
    expect(res.fields.some((f) => f.key === "firstName" && f.isMismatch === true)).toBe(true);
  });

  test("2. Live response for social login + matching document upload preserves mode: 'CONFIRM', loginProvider, and sourceComparison", async () => {
    const initialState = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      loginProvider: "microsoft",
      hasSocialData: true,
      hasLoginData: true,
      documentUploaded: true,
      documentConfirmed: true,
      chatSessionId: "session-live-1",
      socialData: {
        firstName: "John",
        lastName: "Doe",
      },
      loginData: {
        firstName: { value: "John" },
        lastName: { value: "Doe" },
      },
      documentData: {
        firstName: "John",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "male",
      },
      existingUserData: {
        firstName: "John",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "male",
      },
      profileConfirmed: false,
      currentStep: "ASK_UPLOAD_DOCUMENT",
    };
    dbStates["user-live-conflict"] = initialState;

    const res = await ocrService.onboardingChat("user-live-conflict", {
      message: "DOCUMENT_UPLOADED",
      state: initialState,
    });

    expect(res.actionType).toBe("RESOLVE_PROFILE_SOURCE");
    expect(res.mode).toBe("CONFIRM");
    expect(res.loginProvider).toBe("microsoft");
    expect(res.sourceComparison).toBe("DOCUMENT_VS_LOGIN");
  });

  test("3. Live response for social login + conflicting manual entry preserves mode: 'CONFLICT' and sourceComparison: 'MANUAL_VS_LOGIN'", async () => {
    const initialState = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      loginProvider: "microsoft",
      hasSocialData: true,
      hasLoginData: true,
      chatSessionId: "session-live-1",
      socialData: {
        firstName: "John",
        lastName: "Doe",
      },
      loginData: {
        firstName: { value: "John" },
        lastName: { value: "Doe" },
      },
      existingUserData: {
        firstName: "Johnny",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "male",
      },
      profileConfirmed: false,
      currentStep: "RESOLVE_PROFILE_SOURCE",
    };
    dbStates["user-live-conflict"] = initialState;

    const res = await ocrService.onboardingChat("user-live-conflict", {
      message: "male",
      state: initialState,
    });

    expect(res.actionType).toBe("RESOLVE_PROFILE_SOURCE");
    expect(res.mode).toBe("CONFLICT");
    expect(res.loginProvider).toBe("microsoft");
    expect(res.sourceComparison).toBe("MANUAL_VS_LOGIN");
  });
});
