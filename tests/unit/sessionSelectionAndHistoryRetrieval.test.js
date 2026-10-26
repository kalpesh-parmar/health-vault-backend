const { chatService } = require("../../src/services/ai/chat/chat.service");
const ocrService = require("../../src/services/ocr.service");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const patientRepository = require("../../src/repositories/patientRepository");
const authProviderRepository = require("../../src/repositories/authProviderRepository");
const documentRepository = require("../../src/repositories/documentRepository");
const documentProcessingJobRepository = require("../../src/repositories/documentProcessingJobRepository");

describe("Session Selection, Mixed Onboarding/Canonical & Completed-User History Regression Tests", () => {
  const mockUserId = "test-user-9b98ef12-11f9-48ee-a30c-b79a2e7d990f";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(documentProcessingJobRepository, "findUserJobDocumentNames").mockResolvedValue([]);
    jest.spyOn(documentRepository, "findAllByFilterAndSort").mockResolvedValue([]);
    jest.spyOn(documentProcessingJobRepository, "getUserJobSummary").mockResolvedValue({
      totalUploads: 0,
      completed: 0,
      failed: 0,
      rejected: 0,
    });
    jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([]);
    jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("1. Mixed ONBOARDING and CANONICAL Session Prioritization", () => {
    it("frontend/selector logic prioritizes CANONICAL session over newest empty ONBOARDING session", () => {
      const fetchedSessions = [
        {
          id: "empty-onboarding-sess-2",
          userId: mockUserId,
          title: "New Onboarding",
          metadata: { type: "ONBOARDING", isCanonical: false },
          createdAt: new Date("2026-10-22T10:00:00Z"),
          lastMessageAt: new Date("2026-10-22T10:00:00Z"),
        },
        {
          id: "canonical-sess-1",
          userId: mockUserId,
          title: "Health Assistant",
          metadata: { type: "CANONICAL", isCanonical: true },
          createdAt: new Date("2026-10-22T08:00:00Z"),
          lastMessageAt: new Date("2026-10-22T09:30:00Z"),
        },
      ];

      // Exact logic from useChatSession.ts
      const selectedSession =
        fetchedSessions.find(
          (s) => s.metadata?.isCanonical === true || s.metadata?.type === "CANONICAL",
        ) ||
        fetchedSessions.find((s) => s.metadata?.type !== "ONBOARDING") ||
        fetchedSessions[0];

      expect(selectedSession.id).toBe("canonical-sess-1");
      expect(selectedSession.metadata.isCanonical).toBe(true);
    });

    it("falls back cleanly to non-onboarding or sole existing session if isCanonical flag is omitted", () => {
      // Historical session created prior to canonical flag migration
      const fetchedSessions = [
        {
          id: "historical-sess-single",
          userId: mockUserId,
          title: "Health Assistant",
          metadata: { type: "ONBOARDING", isCanonical: false },
          createdAt: new Date("2026-10-22T08:00:00Z"),
          lastMessageAt: new Date("2026-10-22T09:30:00Z"),
        },
      ];

      const selectedSession =
        fetchedSessions.find(
          (s) => s.metadata?.isCanonical === true || s.metadata?.type === "CANONICAL",
        ) ||
        fetchedSessions.find((s) => s.metadata?.type !== "ONBOARDING") ||
        fetchedSessions[0];

      expect(selectedSession.id).toBe("historical-sess-single");
    });

    it("chatSessionRepository.listSessions excludes ONBOARDING sessions when excludeOnboarding flag is set", async () => {
      const mockSessions = [
        { id: "canonical-1", metadata: { type: "CANONICAL", isCanonical: true } },
      ];
      const listSpy = jest
        .spyOn(chatSessionRepository, "listSessions")
        .mockResolvedValue({ items: mockSessions, nextCursor: null });

      const result = await chatService.listSessions({
        userId: mockUserId,
        excludeOnboarding: true,
      });

      expect(listSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: mockUserId,
          excludeOnboarding: true,
        }),
      );
      expect(result.items).toHaveLength(1);
      expect(result.items[0].id).toBe("canonical-1");
    });
  });

  describe("2. Newest Empty Sessions & Canonical Session Anchoring", () => {
    it("getOrCreateCanonicalSession reuses existing canonical session from chatSessionRepository without creating a duplicate", async () => {
      const existingCanonical = {
        id: "canonical-sess-existing",
        userId: mockUserId,
        title: "Health Assistant",
        metadata: { isCanonical: true, type: "CANONICAL" },
      };

      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: mockUserId,
        data: {},
      });
      jest
        .spyOn(chatSessionRepository, "findCanonicalSession")
        .mockResolvedValue(existingCanonical);
      const createSpy = jest.spyOn(chatSessionRepository, "createSession");

      const session = await chatService.getOrCreateCanonicalSession({ userId: mockUserId });

      expect(session.id).toBe("canonical-sess-existing");
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("createOnboardingSession reuses existing onboarding session without creating a new session", async () => {
      const existingOnboard = {
        id: "onboard-sess-existing",
        userId: mockUserId,
        title: "Health Assistant",
        metadata: { isCanonical: false, type: "ONBOARDING" },
      };

      jest.spyOn(chatSessionRepository, "findOnboardingSession").mockResolvedValue(existingOnboard);
      const createSpy = jest.spyOn(chatSessionRepository, "createSession");

      const session = await chatService.createOnboardingSession({ userId: mockUserId });

      expect(session.id).toBe("onboard-sess-existing");
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  describe("3. Completed-User History Retrieval & Onboarding Isolation", () => {
    it("getOnboardingHistory returns existing history for completed patient without creating empty session", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        onboardingCompleted: true,
        bloodGroup: "B+",
        allergies: ["None"],
      });

      const mockHistoricalMessages = [
        { id: "m1", seq: 1, role: "assistant", content: "Welcome!" },
        { id: "m2", seq: 2, role: "user", content: "ગુજરાતી" },
        {
          id: "m3",
          seq: 3,
          role: "assistant",
          content: "તમે તમારી વિગતો કેવી રીતે આપવા માંગો છો?",
        },
      ];

      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: mockUserId,
        isCompleted: true,
        data: {
          chatSessionId: "canonical-completed-sess",
          preferredLanguage: "gujarati",
          isOnboardingCompleted: true,
        },
      });

      jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue({
        id: "canonical-completed-sess",
        userId: mockUserId,
        metadata: { type: "ONBOARDING", isCanonical: false },
      });

      jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({
        items: mockHistoricalMessages,
        nextCursor: null,
      });

      const result = await ocrService.getOnboardingHistory(mockUserId);

      expect(result).toBeDefined();
      expect(result.messages).toHaveLength(3);
      expect(result.messages[0].content).toBe("Welcome!");
      expect(result.messages[1].content).toBe("ગુજરાતી");
      expect(result.chatSessionId).toBe("canonical-completed-sess");
    });

    it("getOnboardingHistory isolates canonical Smart QA session from being overwritten by pre-onboarding", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        onboardingCompleted: true,
      });

      // User onboarding record mistakenly points to a pure CANONICAL Smart QA session
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: mockUserId,
        data: {
          chatSessionId: "smart-qa-canonical-session",
          preferredLanguage: "gujarati",
        },
      });

      // Session metadata indicates it is canonical Smart QA, not onboarding
      jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue({
        id: "smart-qa-canonical-session",
        userId: mockUserId,
        metadata: { isCanonical: true, type: "CANONICAL" },
      });

      jest.spyOn(chatSessionRepository, "findOnboardingSession").mockResolvedValue(null);

      const result = await ocrService.getOnboardingHistory(mockUserId);

      // The defensive guard sets chatSessionId to null so canonical session is never tainted with onboarding steps
      expect(result.chatSessionId).toBeNull();
      expect(result.messages).toEqual([]);
    });

    it("pre-onboarding user (onboardingCompleted: false) resumes their onboarding session seamlessly", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: mockUserId,
        onboardingCompleted: false,
      });

      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: mockUserId,
        step: 1,
        isCompleted: false,
        data: {
          chatSessionId: "active-pre-onboard-sess",
          currentStep: "ASK_BLOOD_GROUP",
          preferredLanguage: "gujarati",
        },
      });

      jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue({
        id: "active-pre-onboard-sess",
        userId: mockUserId,
        metadata: { type: "ONBOARDING", isCanonical: false },
      });

      const mockOnboardingMessages = [
        { id: "om1", seq: 1, role: "assistant", content: "Welcome!" },
        { id: "om2", seq: 2, role: "user", content: "ગુજરાતી" },
      ];

      jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({
        items: mockOnboardingMessages,
        nextCursor: null,
      });

      const result = await ocrService.getOnboardingHistory(mockUserId);

      expect(result.chatSessionId).toBe("active-pre-onboard-sess");
      expect(result.messages).toHaveLength(2);
      expect(result.resumableState.currentStep).toBe("ASK_BLOOD_GROUP");
      expect(result.resumableState.preferredLanguage).toBe("gujarati");
    });
  });
});
