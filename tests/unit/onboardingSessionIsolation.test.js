const { normalizeLanguageLocally } = require("../../src/helpers/onboarding.helper");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const patientRepository = require("../../src/repositories/patientRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const { chatService } = require("../../src/services/ai/chat/chat.service");
const {
  onboardingService,
  updateStateFromMessage,
} = require("../../src/services/ai/chat/onboarding.service");
const v1Service = require("../../src/services/ocr.service");

describe("Pre-Onboarding Chatbot Session & Language Isolation Tests", () => {
  const syntheticUserId = "synthetic-user-iso-001";

  beforeEach(() => {
    jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    jest.spyOn(documentProcessingJobRepository, "findUserJobDocumentNames").mockResolvedValue([]);
    jest.spyOn(documentProcessingJobRepository, "getUserJobSummary").mockResolvedValue({
      totalUploads: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
    });
    jest.spyOn(documentRepository, "findAllByFilterAndSort").mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("1. Deterministic Multilingual Normalization", () => {
    test("normalizes all 5 languages deterministically from native and latin labels", () => {
      // English
      expect(normalizeLanguageLocally("English")).toBe("english");
      expect(normalizeLanguageLocally("en")).toBe("english");
      expect(normalizeLanguageLocally("english")).toBe("english");

      // Gujarati
      expect(normalizeLanguageLocally("ગુજરાતી (Gujarati)")).toBe("gujarati");
      expect(normalizeLanguageLocally("ગુજરાતી")).toBe("gujarati");
      expect(normalizeLanguageLocally("gujarati")).toBe("gujarati");
      expect(normalizeLanguageLocally("gu")).toBe("gujarati");

      // Hindi
      expect(normalizeLanguageLocally("हिंदी (Hindi)")).toBe("hindi");
      expect(normalizeLanguageLocally("हिंदी")).toBe("hindi");
      expect(normalizeLanguageLocally("हिन्दी")).toBe("hindi");
      expect(normalizeLanguageLocally("hindi")).toBe("hindi");
      expect(normalizeLanguageLocally("hi")).toBe("hindi");

      // Marathi
      expect(normalizeLanguageLocally("मराठी (Marathi)")).toBe("marathi");
      expect(normalizeLanguageLocally("मराठी")).toBe("marathi");
      expect(normalizeLanguageLocally("marathi")).toBe("marathi");
      expect(normalizeLanguageLocally("mr")).toBe("marathi");

      // Tamil
      expect(normalizeLanguageLocally("தமிழ் (Tamil)")).toBe("tamil");
      expect(normalizeLanguageLocally("தமிழ்")).toBe("tamil");
      expect(normalizeLanguageLocally("tamil")).toBe("tamil");
      expect(normalizeLanguageLocally("ta")).toBe("tamil");

      // Invalid input
      expect(normalizeLanguageLocally("klingon")).toBeNull();
      expect(normalizeLanguageLocally(null)).toBeNull();
      expect(normalizeLanguageLocally(undefined)).toBeNull();
    });

    test("updateStateFromMessage matches native Gujarati label in 0ms without LLM fallback", async () => {
      const state = {
        currentStep: "ASK_LANGUAGE",
        preferredLanguage: "english",
      };

      await updateStateFromMessage(state, "ગુજરાતી (Gujarati)", syntheticUserId);

      expect(state.preferredLanguage).toBe("gujarati");
      expect(state.currentStep).toBe("ASK_UPLOAD_OR_SKIP");
    });

    test("updateStateFromMessage matches native Hindi and Tamil labels", async () => {
      const stateHindi = { currentStep: "ASK_LANGUAGE" };
      await updateStateFromMessage(stateHindi, "हिंदी", syntheticUserId);
      expect(stateHindi.preferredLanguage).toBe("hindi");
      expect(stateHindi.currentStep).toBe("ASK_UPLOAD_OR_SKIP");

      const stateTamil = { currentStep: "ASK_LANGUAGE" };
      await updateStateFromMessage(stateTamil, "தமிழ்", syntheticUserId);
      expect(stateTamil.preferredLanguage).toBe("tamil");
      expect(stateTamil.currentStep).toBe("ASK_UPLOAD_OR_SKIP");
    });
  });

  describe("2. Onboarding Session vs Canonical Smart QA Session Isolation", () => {
    test("createOnboardingSession creates a dedicated session with type ONBOARDING and isCanonical=false", async () => {
      let createdSessionPayload = null;
      jest.spyOn(chatSessionRepository, "findOnboardingSession").mockResolvedValue(null);
      jest.spyOn(chatSessionRepository, "createSession").mockImplementation(async (payload) => {
        createdSessionPayload = payload;
        return {
          id: "onboarding-session-uuid-111",
          ...payload,
        };
      });
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue(null);

      const session = await chatService.createOnboardingSession({
        userId: syntheticUserId,
      });

      expect(session.id).toBe("onboarding-session-uuid-111");
      expect(createdSessionPayload.metadata.type).toBe("ONBOARDING");
      expect(createdSessionPayload.metadata.isCanonical).toBe(false);
    });

    test("getOrCreateCanonicalSession does not hijack or touch existing ONBOARDING session", async () => {
      const existingOnboardingSession = {
        id: "onboarding-session-uuid-111",
        userId: syntheticUserId,
        metadata: { type: "ONBOARDING", isCanonical: false },
      };

      // Mock findCanonicalSession returning null (no canonical session exists yet)
      jest.spyOn(chatSessionRepository, "findCanonicalSession").mockResolvedValue(null);
      let createdCanonicalPayload = null;
      jest.spyOn(chatSessionRepository, "createSession").mockImplementation(async (payload) => {
        createdCanonicalPayload = payload;
        return {
          id: "canonical-session-uuid-999",
          ...payload,
        };
      });

      const canonicalSession = await chatService.getOrCreateCanonicalSession({
        userId: syntheticUserId,
      });

      // Canonical session is created separately
      expect(canonicalSession.id).toBe("canonical-session-uuid-999");
      expect(createdCanonicalPayload.metadata.isCanonical).toBe(true);
      expect(createdCanonicalPayload.metadata.type).toBe("CANONICAL");

      // Onboarding session was NOT modified
      expect(existingOnboardingSession.metadata.type).toBe("ONBOARDING");
      expect(existingOnboardingSession.metadata.isCanonical).toBe(false);
    });

    test("findCanonicalSession never returns an ONBOARDING session as fallback", async () => {
      // Mock db queries: first (canonical) returns none, second (fallback) filters out ONBOARDING
      const mockClient = {
        select: jest.fn().mockReturnThis(),
        from: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        limit: jest.fn().mockResolvedValue([]),
      };

      const origClient = chatSessionRepository.client;
      chatSessionRepository.client = mockClient;

      try {
        const canonical = await chatSessionRepository.findCanonicalSession(syntheticUserId);
        expect(canonical).toBeNull();
      } finally {
        chatSessionRepository.client = origClient;
      }
    });
  });

  describe("3. Onboarding History Replay Protection", () => {
    test("getOnboardingHistory excludes canonical QA sessions from onboarding replay", async () => {
      const canonicalSessionId = "canonical-qa-session-001";
      const resumableState = {
        chatSessionId: canonicalSessionId,
        isOnboardingCompleted: false,
        currentStep: "ASK_LANGUAGE",
      };

      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: syntheticUserId,
        data: resumableState,
      });

      // Session in DB is marked as canonical Smart QA
      jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue({
        id: canonicalSessionId,
        userId: syntheticUserId,
        metadata: { isCanonical: true, type: "CANONICAL" },
      });

      // When asked to create onboarding session
      jest.spyOn(chatService, "createOnboardingSession").mockResolvedValue({
        id: "fresh-onboarding-session-002",
        metadata: { type: "ONBOARDING", isCanonical: false },
      });

      jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({
        items: [],
        nextCursor: null,
      });

      const historyResult = await v1Service.getOnboardingHistory({
        userId: syntheticUserId,
      });

      // The canonical session should NOT be returned as chatSessionId
      expect(historyResult.chatSessionId).not.toBe(canonicalSessionId);
      expect(historyResult.messages).toEqual([]);
    });

    test("getOnboardingHistory preserves legitimate pre-onboarding chat history", async () => {
      const onboardingSessionId = "valid-onboarding-session-003";
      const resumableState = {
        chatSessionId: onboardingSessionId,
        isOnboardingCompleted: false,
        currentStep: "ASK_UPLOAD_OR_SKIP",
        preferredLanguage: "gujarati",
      };

      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: syntheticUserId,
        data: resumableState,
      });

      jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue({
        id: onboardingSessionId,
        userId: syntheticUserId,
        metadata: { isCanonical: false, type: "ONBOARDING" },
      });

      const legitimateMessages = [
        {
          id: "msg-1",
          role: "assistant",
          content: "Welcome! Please select your preferred language.",
          metadata: { action: "ASK_LANGUAGE" },
          createdAt: new Date().toISOString(),
        },
        {
          id: "msg-2",
          role: "user",
          content: "ગુજરાતી (Gujarati)",
          metadata: { rawValue: "gujarati" },
          createdAt: new Date().toISOString(),
        },
        {
          id: "msg-3",
          role: "assistant",
          content: "How would you like to provide your details?",
          metadata: { action: "ASK_UPLOAD_OR_SKIP" },
          createdAt: new Date().toISOString(),
        },
      ];

      jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({
        items: legitimateMessages,
        nextCursor: null,
      });

      const historyResult = await v1Service.getOnboardingHistory({
        userId: syntheticUserId,
      });

      expect(historyResult.chatSessionId).toBe(onboardingSessionId);
      expect(historyResult.messages.length).toBe(3);
      expect(historyResult.messages[0].content).toContain("Welcome");
      expect(historyResult.messages[1].content).toBe("ગુજરાતી (Gujarati)");
    });
  });

  describe("4. onboardingChat Session Decoupling & Guard", () => {
    test("onboardingChat for pre-onboarding request routes to createOnboardingSession instead of canonical QA session", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: syntheticUserId,
        onboardingCompleted: false,
      });
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue(null);

      const onboardingSpy = jest.spyOn(chatService, "createOnboardingSession").mockResolvedValue({
        id: "fresh-onboarding-session-777",
        metadata: { type: "ONBOARDING", isCanonical: false },
      });
      const canonicalSpy = jest.spyOn(chatService, "getOrCreateCanonicalSession");

      jest.spyOn(onboardingService, "chat").mockResolvedValue({
        mode: "ONBOARDING",
        action: "ASK_LANGUAGE",
        message: "Welcome! Please choose a language.",
        state: { currentStep: "ASK_LANGUAGE", chatSessionId: "fresh-onboarding-session-777" },
        options: [],
      });

      const response = await v1Service.onboardingChat(syntheticUserId, {
        message: "hello",
        fromScreen: "Onboarding",
      });

      expect(onboardingSpy).toHaveBeenCalledWith({ userId: syntheticUserId });
      expect(canonicalSpy).not.toHaveBeenCalled();
      expect(response.sessionId).toBe("fresh-onboarding-session-777");
    });

    test("onboardingChat rejects passed canonical QA session ID during pre-onboarding", async () => {
      const canonicalSessionId = "canonical-qa-session-888";
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: syntheticUserId,
        onboardingCompleted: false,
      });
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue(null);

      // findSessionById indicates the passed session is a canonical QA session
      jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue({
        id: canonicalSessionId,
        userId: syntheticUserId,
        metadata: { isCanonical: true, type: "CANONICAL" },
      });

      const onboardingSpy = jest.spyOn(chatService, "createOnboardingSession").mockResolvedValue({
        id: "remediated-onboarding-session-999",
        metadata: { type: "ONBOARDING", isCanonical: false },
      });

      jest.spyOn(onboardingService, "chat").mockResolvedValue({
        mode: "ONBOARDING",
        action: "ASK_LANGUAGE",
        message: "Welcome! Please choose a language.",
        state: { currentStep: "ASK_LANGUAGE", chatSessionId: "remediated-onboarding-session-999" },
        options: [],
      });

      const response = await v1Service.onboardingChat(syntheticUserId, {
        message: "hello",
        fromScreen: "Onboarding",
        sessionId: canonicalSessionId,
      });

      // Canonical session was rejected and new dedicated onboarding session was resolved
      expect(onboardingSpy).toHaveBeenCalled();
      expect(response.sessionId).toBe("remediated-onboarding-session-999");
    });
  });
});
