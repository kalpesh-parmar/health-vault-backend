const { chatService } = require("../src/services/ai/chat/chat.service");
const chatSessionRepository = require("../src/repositories/chatSessionRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
const patientRepository = require("../src/repositories/patientRepository");
const authProviderRepository = require("../src/repositories/authProviderRepository");
const documentRepository = require("../src/repositories/documentRepository");
const documentProcessingJobRepository = require("../src/repositories/documentProcessingJobRepository");
const ocrService = require("../src/services/ocr.service");
const unifiedChatHelper = require("../src/helpers/unifiedChat.helper");

describe("Phase 5: Canonical Session Lifecycle & Unified Storage Architecture", () => {
  const testUserId = "user-canonical-uuid-1";

  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(authProviderRepository, "findByUserId").mockResolvedValue([]);
    jest.spyOn(documentRepository, "findAllByFilterAndSort").mockResolvedValue([]);
    jest.spyOn(documentProcessingJobRepository, "findUserJobDocumentNames").mockResolvedValue([]);
    jest.spyOn(documentProcessingJobRepository, "getUserJobSummary").mockResolvedValue(null);
    jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});
  });

  describe("1. chatService.getOrCreateCanonicalSession", () => {
    it("creates a fresh canonical session when user has no prior sessions and anchors in user_onboarding", async () => {
      const mockCreatedSession = {
        id: "sess-canonical-100",
        userId: testUserId,
        title: "Health Assistant",
        metadata: { isCanonical: true, type: "CANONICAL" },
      };

      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: testUserId,
        data: {},
      });
      jest.spyOn(chatSessionRepository, "findCanonicalSession").mockResolvedValue(null);
      jest.spyOn(chatSessionRepository, "createSession").mockResolvedValue(mockCreatedSession);
      const updateOnboardSpy = jest
        .spyOn(userOnboardingRepository, "updateByUserId")
        .mockResolvedValue({});

      const session = await chatService.getOrCreateCanonicalSession({ userId: testUserId });

      expect(session).toBeDefined();
      expect(session.id).toBe("sess-canonical-100");
      expect(chatSessionRepository.createSession).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: testUserId,
          title: "Health Assistant",
          metadata: expect.objectContaining({ isCanonical: true, type: "CANONICAL" }),
        }),
      );
      expect(updateOnboardSpy).toHaveBeenCalledWith(
        testUserId,
        expect.objectContaining({
          data: expect.objectContaining({ chatSessionId: "sess-canonical-100" }),
        }),
      );
    });

    it("reuses existing session referenced in user_onboarding.data.chatSessionId", async () => {
      const existingSession = {
        id: "sess-existing-from-onboarding",
        userId: testUserId,
        title: "Health Assistant",
        metadata: { isCanonical: true, type: "CANONICAL" },
      };

      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: testUserId,
        data: { chatSessionId: "sess-existing-from-onboarding" },
      });
      jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue(existingSession);
      const createSpy = jest.spyOn(chatSessionRepository, "createSession");

      const session = await chatService.getOrCreateCanonicalSession({ userId: testUserId });

      expect(session.id).toBe("sess-existing-from-onboarding");
      expect(createSpy).not.toHaveBeenCalled();
    });

    it("reuses canonical session discovered in chatSessionRepository when onboarding record lacks chatSessionId", async () => {
      const existingCanonical = {
        id: "sess-found-in-repo",
        userId: testUserId,
        title: "Health Assistant",
        metadata: { isCanonical: true, type: "CANONICAL" },
      };

      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: testUserId,
        data: {},
      });
      jest
        .spyOn(chatSessionRepository, "findCanonicalSession")
        .mockResolvedValue(existingCanonical);
      const updateOnboardSpy = jest
        .spyOn(userOnboardingRepository, "updateByUserId")
        .mockResolvedValue({});
      const createSpy = jest.spyOn(chatSessionRepository, "createSession");

      const session = await chatService.getOrCreateCanonicalSession({ userId: testUserId });

      expect(session.id).toBe("sess-found-in-repo");
      expect(createSpy).not.toHaveBeenCalled();
      expect(updateOnboardSpy).toHaveBeenCalledWith(
        testUserId,
        expect.objectContaining({
          data: expect.objectContaining({ chatSessionId: "sess-found-in-repo" }),
        }),
      );
    });

    it("marks an existing non-canonical session as canonical when resolved", async () => {
      const existingNonCanonical = {
        id: "sess-legacy-1",
        userId: testUserId,
        title: "Health Onboarding",
        metadata: { type: "ONBOARDING" },
      };

      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: testUserId,
        data: { chatSessionId: "sess-legacy-1" },
      });
      jest.spyOn(chatSessionRepository, "findSessionById").mockResolvedValue(existingNonCanonical);
      const markSpy = jest
        .spyOn(chatSessionRepository, "markAsCanonical")
        .mockResolvedValue({ ...existingNonCanonical, metadata: { isCanonical: true } });

      const session = await chatService.getOrCreateCanonicalSession({ userId: testUserId });

      expect(session.id).toBe("sess-legacy-1");
      expect(markSpy).toHaveBeenCalledWith("sess-legacy-1", testUserId);
    });
  });

  describe("2. Single Session Resolution across Onboarding & Dashboard Actions", () => {
    const canonicalSessionId = "sess-canonical-shared-999";

    beforeEach(() => {
      jest.spyOn(chatService, "getOrCreateCanonicalSession").mockResolvedValue({
        id: canonicalSessionId,
        userId: testUserId,
        title: "Health Assistant",
        metadata: { isCanonical: true },
      });
      jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-test-1" });
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: testUserId,
        firstName: "Test",
        lastName: "User",
        dateOfBirth: "1990-01-01",
        gender: "MALE",
        bloodGroup: "O+",
        allergies: [],
        onboardingCompleted: true,
      });
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: testUserId,
        data: {
          chatSessionId: canonicalSessionId,
          isOnboardingCompleted: true,
          medicationFlowDone: true,
          medicinesConfirmed: true,
          bloodGroupSkipped: true,
          allergiesSkipped: true,
          currentStep: "COMPLETE",
        },
      });
    });

    it("returns canonical sessionId in unified onboarding response (CASE 3)", async () => {
      jest.spyOn(patientRepository, "findById").mockResolvedValue({
        id: testUserId,
        firstName: "Test",
        lastName: "User",
        dateOfBirth: "1990-01-01",
        gender: "MALE",
        onboardingCompleted: false,
      });
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: testUserId,
        data: {
          chatSessionId: canonicalSessionId,
          currentStep: "ASK_LANGUAGE",
          isOnboardingCompleted: false,
        },
      });

      const res = await ocrService.onboardingChat(testUserId, {
        message: "hello",
        actionType: "ONBOARDING",
        state: { currentStep: "ASK_LANGUAGE" },
      });

      expect(res.sessionId).toBe(canonicalSessionId);
    });

    it("attaches ADD_DOCUMENT action to canonical session without spawning an extra session", async () => {
      const createSessionSpy = jest.spyOn(chatService, "createSession");

      const result = await unifiedChatHelper.executeAddDocumentAction({
        userId: testUserId,
        actionData: {
          jobId: "job-1",
          fileName: "blood_test.pdf",
          fileUri: "s3://bucket/blood_test.pdf",
          fileType: "pdf",
          extractedMedicines: [],
        },
        sessionId: null, // Client did not pass sessionId
        preferredLanguage: "english",
        isOnboardingCompleted: true,
        documentPersistenceService: {
          addDocument: jest.fn().mockResolvedValue({
            document: { id: "doc-1", fileName: "blood_test.pdf" },
            isBatch: false,
          }),
        },
        documentOcrJobService: {
          getJobStatus: jest.fn().mockResolvedValue({ status: "COMPLETED" }),
        },
        chatService,
        chatSessionRepository,
        ocrStatusEnum: { COMPLETED: "COMPLETED" },
      });

      expect(result.sessionId).toBe(canonicalSessionId);
      expect(createSessionSpy).not.toHaveBeenCalled();
      expect(chatSessionRepository.appendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: canonicalSessionId,
          userId: testUserId,
          role: "assistant",
        }),
      );
    });

    it("post-onboarding CONFIRM_MEDICINES attaches to canonical session without creating Medication Chat", async () => {
      const createSessionSpy = jest.spyOn(chatService, "createSession");

      const result = await ocrService.onboardingChat(testUserId, {
        actionType: "CONFIRM_MEDICINES",
        actionData: {
          medicines: [
            {
              name: "Metformin",
              dosage: "500mg",
              frequency: "twice daily",
              intakeTimes: ["08:00", "20:00"],
            },
          ],
        },
      });

      expect(result.sessionId).toBe(canonicalSessionId);
      expect(createSessionSpy).not.toHaveBeenCalled();
      expect(chatSessionRepository.appendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: canonicalSessionId,
          userId: testUserId,
          metadata: expect.objectContaining({ actionType: "CONFIRM_MEDICINES" }),
        }),
      );
    });

    it("post-onboarding SKIP_MEDICINES attaches to canonical session without creating Medication Chat", async () => {
      const createSessionSpy = jest.spyOn(chatService, "createSession");

      const result = await ocrService.onboardingChat(testUserId, {
        actionType: "SKIP_MEDICINES",
        actionData: { skipAll: true },
      });

      expect(result.sessionId).toBe(canonicalSessionId);
      expect(createSessionSpy).not.toHaveBeenCalled();
      expect(chatSessionRepository.appendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: canonicalSessionId,
          userId: testUserId,
          metadata: expect.objectContaining({ actionType: "SKIP_MEDICINES" }),
        }),
      );
    });

    it("NORMAL_CHAT without sessionId uses canonical session", async () => {
      jest.spyOn(chatService, "sendMessage").mockResolvedValue({
        sessionId: canonicalSessionId,
        reply: "You have normal blood pressure.",
        ai: { sessionId: canonicalSessionId },
      });

      const result = await ocrService.onboardingChat(testUserId, {
        actionType: "NORMAL_CHAT",
        message: "What is my blood pressure?",
        sessionId: null,
      });

      expect(result.sessionId).toBe(canonicalSessionId);
      expect(chatService.sendMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: canonicalSessionId,
          userId: testUserId,
          question: "What is my blood pressure?",
        }),
      );
    });
  });

  describe("3. getOnboardingHistory and Session Consistency", () => {
    const canonicalSessionId = "sess-canonical-history-1";

    it("returns canonical chatSessionId and chronological messages", async () => {
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: testUserId,
        data: { chatSessionId: canonicalSessionId, currentStep: "COMPLETE" },
      });
      jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({
        items: [
          { id: "m1", seq: 1, role: "assistant", content: "Select your language" },
          { id: "m2", seq: 2, role: "user", content: "English" },
          { id: "m3", seq: 3, role: "assistant", content: "Onboarding complete!" },
        ],
      });

      const history = await ocrService.getOnboardingHistory(testUserId);

      expect(history.chatSessionId).toBe(canonicalSessionId);
      expect(history.messages).toHaveLength(3);
      expect(history.messages[0].content).toBe("Select your language");
      expect(history.messages[2].content).toBe("Onboarding complete!");
      expect(chatSessionRepository.listMessages).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: canonicalSessionId,
          userId: testUserId,
          direction: "after",
        }),
      );
    });

    it("falls back to getOrCreateCanonicalSession if resumableState lacks chatSessionId", async () => {
      jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
        userId: testUserId,
        data: {},
      });
      jest.spyOn(chatService, "getOrCreateCanonicalSession").mockResolvedValue({
        id: "sess-recovered-canonical",
      });
      jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue({ items: [] });

      const history = await ocrService.getOnboardingHistory(testUserId);

      expect(history.chatSessionId).toBe("sess-recovered-canonical");
      expect(chatService.getOrCreateCanonicalSession).toHaveBeenCalledWith({ userId: testUserId });
    });
  });
});
