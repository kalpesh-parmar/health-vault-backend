const { onboardingService } = require("../src/services/ai/chat/onboarding.service");
const patientRepository = require("../src/repositories/patientRepository");
const authProviderRepository = require("../src/repositories/authProviderRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
const documentProcessingJobRepository = require("../src/repositories/documentProcessingJobRepository");
const chatSessionRepository = require("../src/repositories/chatSessionRepository");
const { chatService } = require("../src/services/ai/chat/chat.service");
const ocrService = require("../src/services/ocr.service");

describe("Phase 14: Conflict Card State Persistence & Replay Unit Tests", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("1. RESOLVE_PROFILE_SOURCE appends chat message with complete metadata (mode, sourceComparison, loginProvider)", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-conflict-1",
      firstName: "John",
      lastName: "Doe",
      gender: "male",
    });
    jest
      .spyOn(authProviderRepository, "findByUserId")
      .mockResolvedValue([{ provider: "microsoft" }]);
    jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({ data: {} });
    jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});
    jest
      .spyOn(chatService, "createOnboardingSession")
      .mockResolvedValue({ id: "session-conflict-1" });
    jest
      .spyOn(chatService, "getOrCreateCanonicalSession")
      .mockResolvedValue({ id: "session-conflict-1" });

    let appendedMessagePayload = null;
    jest.spyOn(chatService, "appendChatMessage").mockImplementation(async (payload) => {
      appendedMessagePayload = payload;
      return { id: "msg-123", createdAt: new Date() };
    });

    const state = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      loginProvider: "microsoft",
      hasSocialData: true,
      documentUploaded: true,
      documentConfirmed: true,
      chatSessionId: "session-conflict-1",
      socialData: {
        firstName: "John",
        lastName: "Doe",
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
      currentStep: "RESOLVE_PROFILE_SOURCE",
    };

    const res = await onboardingService.chat("hello", [], state, "user-conflict-1");
    expect(res.action).toBe("RESOLVE_PROFILE_SOURCE");
    expect(res.mode).toBe("CONFLICT");
    expect(res.sourceComparison).toBe("DOCUMENT_VS_LOGIN");
    expect(res.loginProvider).toBe("microsoft");

    // Verify metadata persisted to chatService.appendChatMessage
    expect(appendedMessagePayload).not.toBeNull();
    expect(appendedMessagePayload.metadata).toMatchObject({
      action: "RESOLVE_PROFILE_SOURCE",
      mode: "CONFLICT",
      sourceComparison: "DOCUMENT_VS_LOGIN",
      loginProvider: "microsoft",
    });
    expect(Array.isArray(appendedMessagePayload.metadata.fields)).toBe(true);
    expect(
      appendedMessagePayload.metadata.fields.some(
        (f) => f.key === "firstName" && f.isMismatch === true,
      ),
    ).toBe(true);
  });

  test("2. Provider resolution populates state.loginProvider from authProviderRepository when state.hasLoginData is already true", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-conflict-2",
      firstName: "Alice",
      lastName: "Smith",
    });
    jest
      .spyOn(authProviderRepository, "findByUserId")
      .mockResolvedValue([{ provider: "microsoft" }]);
    jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({ data: {} });
    let savedState = null;
    jest
      .spyOn(userOnboardingRepository, "updateByUserId")
      .mockImplementation(async (userId, update) => {
        savedState = update.data;
        return {};
      });
    jest.spyOn(chatService, "createOnboardingSession").mockResolvedValue({ id: "session-2" });
    jest.spyOn(chatService, "getOrCreateCanonicalSession").mockResolvedValue({ id: "session-2" });
    jest
      .spyOn(chatService, "appendChatMessage")
      .mockResolvedValue({ id: "msg-456", createdAt: new Date() });

    // Simulate state where loginData was already populated in prior turn, but loginProvider was missing
    const state = {
      preferredLanguage: "english",
      flowMode: "MANUAL",
      hasLoginData: true,
      loginData: {
        firstName: { value: "Alice", verified: false, provenance: "profile" },
        lastName: { value: "Smith", verified: false, provenance: "profile" },
      },
      existingUserData: {
        firstName: "Alyssa",
        lastName: "Smith",
        dateOfBirth: "1992-03-15",
        gender: "female",
      },
      profileConfirmed: false,
      currentStep: "RESOLVE_PROFILE_SOURCE",
    };

    const res = await onboardingService.chat("hello", [], state, "user-conflict-2");
    expect(res.state.loginProvider).toBe("microsoft");
    expect(res.loginProvider).toBe("microsoft");
    expect(res.mode).toBe("CONFLICT");
    expect(res.sourceComparison).toBe("MANUAL_VS_LOGIN");

    // Verify saved state in userOnboardingRepository contains loginProvider
    expect(savedState).not.toBeNull();
    expect(savedState.loginProvider).toBe("microsoft");
  });

  test("3. getOnboardingHistory returns resumableState with loginProvider and preserves message metadata", async () => {
    const historicalMessages = [
      {
        id: "msg-hist-1",
        sessionId: "session-3",
        role: "assistant",
        content: "I found two different sources for your details.",
        metadata: JSON.stringify({
          action: "RESOLVE_PROFILE_SOURCE",
          mode: "CONFLICT",
          sourceComparison: "DOCUMENT_VS_LOGIN",
          loginProvider: "microsoft",
          fields: [
            {
              key: "firstName",
              label: "First Name",
              isMismatch: true,
              loginValue: "John",
              documentValue: "Johnny",
            },
          ],
        }),
        createdAt: new Date(),
      },
    ];

    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      userId: "user-conflict-3",
      data: {
        currentStep: "RESOLVE_PROFILE_SOURCE",
        chatSessionId: "session-3",
        loginProvider: "microsoft",
        isOnboardingCompleted: false,
      },
      isCompleted: false,
    });
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user-conflict-3",
      onboardingCompleted: false,
    });
    jest.spyOn(documentProcessingJobRepository, "findUserJobDocumentNames").mockResolvedValue([]);
    jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({
      items: historicalMessages,
    });

    const history = await ocrService.getOnboardingHistory("user-conflict-3");

    expect(history.currentStep).toBe("RESOLVE_PROFILE_SOURCE");
    expect(history.resumableState).not.toBeNull();
    expect(history.resumableState.loginProvider).toBe("microsoft");
    expect(history.messages.length).toBe(1);

    const histMeta = JSON.parse(history.messages[0].metadata);
    expect(histMeta.mode).toBe("CONFLICT");
    expect(histMeta.sourceComparison).toBe("DOCUMENT_VS_LOGIN");
    expect(histMeta.loginProvider).toBe("microsoft");
  });
});
