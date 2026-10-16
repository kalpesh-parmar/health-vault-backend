const { onboardingService } = require("../../src/services/ai/chat/onboarding.service");
const { chatService } = require("../../src/services/ai/chat/chat.service");
const patientRepository = require("../../src/repositories/patientRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const documentIdentityService = require("../../src/services/documentIdentity.service");
const ocrService = require("../../src/services/ocr.service");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");

jest.mock("../../src/repositories/patientRepository", () => ({
  findById: jest.fn(),
  updateById: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/repositories/authProviderRepository", () => ({
  findByUserId: jest.fn().mockResolvedValue([{ provider: "email" }]),
}));

jest.mock("../../src/repositories/userOnboardingRepository", () => ({
  findByUserId: jest.fn(),
  create: jest.fn().mockResolvedValue({}),
  updateByUserId: jest.fn().mockResolvedValue({}),
}));

jest.mock("../../src/repositories/chatSessionRepository", () => ({
  listMessages: jest.fn(),
  appendMessage: jest.fn(),
}));

jest.mock("../../src/services/documentIdentity.service", () => ({
  resolveCanonicalDocument: jest.fn(),
}));

jest.mock("../../src/repositories/documentProcessingJobRepository", () => ({
  findUserJobDocumentNames: jest.fn().mockResolvedValue([]),
}));

describe("POST_ONBOARDING Dashboard Flow Regression Test Suite", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Scenario A: GO_TO_DASHBOARD explicitly persists selectedOption = 'DASHBOARD'", () => {
    test("persists isOnboardingCompleted=true and selectedOption='DASHBOARD' without synthetic chat messages", async () => {
      const appendSpy = jest.spyOn(chatService, "appendChatMessage");
      appendSpy.mockClear();

      let savedData = null;
      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId: "user-a",
        data: {
          currentStep: "MEDICINE_OPTIONS",
          flowMode: "UPLOAD",
          isOnboardingCompleted: false,
        },
      });
      userOnboardingRepository.updateByUserId.mockImplementation((uid, update) => {
        savedData = update.data;
        return Promise.resolve({});
      });

      const state = {
        userId: "user-a",
        chatSessionId: "session-a",
        flowMode: "UPLOAD",
        currentStep: "MEDICINE_OPTIONS",
        preferredLanguage: "english",
        medicationFlowDone: false,
        medicinesConfirmed: false,
      };

      const res = await onboardingService.chat(
        "GO_TO_DASHBOARD",
        [],
        state,
        "user-a",
        "session-a",
        "Go to Dashboard",
      );

      expect(res.state.isOnboardingCompleted).toBe(true);
      expect(res.state.selectedOption).toBe("DASHBOARD");
      expect(savedData.selectedOption).toBe("DASHBOARD");
      expect(savedData.isOnboardingCompleted).toBe(true);
      // Exactly 1 user message should be persisted for navigation, and zero assistant messages
      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-a",
          userId: "user-a",
          role: "user",
          content: "Go to Dashboard",
          metadata: expect.objectContaining({
            action: "DASHBOARD",
            selectedOption: "DASHBOARD",
          }),
        }),
      );
    });
  });

  describe("Scenario B: SKIP_ONBOARDING does not mark DASHBOARD as selectedOption", () => {
    test("skipping onboarding persists completion without selectedOption='DASHBOARD'", async () => {
      let savedData = null;
      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId: "user-b",
        data: {
          currentStep: "ASK_BLOOD_GROUP",
          flowMode: "MANUAL",
          isOnboardingCompleted: false,
        },
      });
      userOnboardingRepository.updateByUserId.mockImplementation((uid, update) => {
        savedData = update.data;
        return Promise.resolve({});
      });

      const state = {
        userId: "user-b",
        chatSessionId: "session-b",
        flowMode: "MANUAL",
        currentStep: "ASK_BLOOD_GROUP",
        preferredLanguage: "english",
        hasSkipped: true,
      };

      const res = await onboardingService.chat("SKIP", [], state, "user-b", "session-b", "Skip");

      // Should not infer DASHBOARD selection from skipping
      expect(res.state.selectedOption).not.toBe("DASHBOARD");
      if (savedData) {
        expect(savedData.selectedOption).not.toBe("DASHBOARD");
      }
    });
  });

  describe("Scenario C: ASK_REPORT → GO_TO_DASHBOARD preserves both report and dashboard state", () => {
    test("ASK_REPORT persists summary card and subsequent GO_TO_DASHBOARD persists DASHBOARD selection without duplicating messages", async () => {
      const appendSpy = jest.spyOn(chatService, "appendChatMessage").mockResolvedValue({
        id: "msg-report-1",
        createdAt: new Date(),
      });

      const syntheticDoc = {
        id: "doc-c-1",
        fileName: "Blood_Report.pdf",
        documentType: "LAB_REPORT",
        summary: "Blood glucose 90 mg/dL normal",
        abnormalResults: [],
        normalResults: [{ testName: "Glucose", value: "90" }],
        isLabReport: true,
        structuredExtractedData: {
          patientInfo: { name: "Test Patient" },
        },
      };
      documentIdentityService.resolveCanonicalDocument.mockResolvedValue(syntheticDoc);

      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId: "user-c",
        data: {
          currentStep: "MEDICINE_OPTIONS",
          flowMode: "UPLOAD",
          documentId: "doc-c-1",
          documentExtracted: true,
          documentData: { patientName: "Test Patient" },
          documentRecord: syntheticDoc,
        },
      });

      const state = {
        userId: "user-c",
        chatSessionId: "session-c",
        flowMode: "UPLOAD",
        currentStep: "MEDICINE_OPTIONS",
        documentId: "doc-c-1",
        documentExtracted: true,
        documentData: { patientName: "Test Patient" },
        documentRecord: syntheticDoc,
        preferredLanguage: "english",
      };

      // Step 1: User clicks "Ask About My Report"
      const reportRes = await onboardingService.chat(
        "ASK_REPORT",
        [],
        state,
        "user-c",
        "session-c",
        "Ask About My Report",
      );

      expect(reportRes.action).toBe("ASK_REPORT");
      expect(reportRes.document).toBeDefined();
      expect(appendSpy).toHaveBeenCalled(); // ASK_REPORT assistant message is persisted
      const reportCallCount = appendSpy.mock.calls.length;

      // Step 2: User clicks "Go to Dashboard"
      let savedData = null;
      userOnboardingRepository.updateByUserId.mockImplementation((uid, update) => {
        savedData = update.data;
        return Promise.resolve({});
      });

      const dashRes = await onboardingService.chat(
        "GO_TO_DASHBOARD",
        [],
        reportRes.state,
        "user-c",
        "session-c",
        "Go to Dashboard",
      );

      expect(dashRes.state.isOnboardingCompleted).toBe(true);
      expect(dashRes.state.selectedOption).toBe("DASHBOARD");
      expect(savedData.selectedOption).toBe("DASHBOARD");
      // Exactly 1 user selection message should be appended for navigation, and 0 synthetic assistant messages
      expect(appendSpy.mock.calls.length).toBe(reportCallCount + 1);
      const lastCall = appendSpy.mock.calls[appendSpy.mock.calls.length - 1][0];
      expect(lastCall.role).toBe("user");
      expect(lastCall.content).toBe("Go to Dashboard");
      expect(lastCall.metadata.selectedOption).toBe("DASHBOARD");
    });
  });

  describe("Scenario D: App restart and history restoration", () => {
    test("getOnboardingHistory restores isOnboardingCompleted, selectedOption, and persisted user Dashboard bubble", async () => {
      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId: "user-d",
        data: {
          currentStep: "POST_ONBOARDING",
          isOnboardingCompleted: true,
          medicationFlowDone: true,
          medicinesConfirmed: true,
          selectedOption: "DASHBOARD",
          chatSessionId: "session-d",
          preferredLanguage: "english",
        },
      });

      patientRepository.findById.mockResolvedValue({
        id: "user-d",
        onboardingCompleted: true,
        preferredLanguage: "english",
      });

      chatSessionRepository.listMessages.mockResolvedValue({
        items: [
          {
            id: "msg-opts",
            role: "assistant",
            content: "What would you like to do next?",
            metadata: {
              action: "MEDICINE_OPTIONS",
              options: [
                { key: "ADD_MEDICINES", label: "Add Medicines" },
                { key: "ASK_REPORT", label: "Ask About My Report" },
                { key: "DASHBOARD", label: "Go to Dashboard" },
              ],
            },
          },
          {
            id: "msg-user-dash",
            role: "user",
            content: "Go to Dashboard",
            metadata: {
              action: "DASHBOARD",
              actionType: "DASHBOARD",
              selectedOption: "DASHBOARD",
            },
          },
        ],
        nextCursor: null,
      });

      const history = await ocrService.getOnboardingHistory("user-d");

      expect(history.resumableState.isOnboardingCompleted).toBe(true);
      expect(history.resumableState.selectedOption).toBe("DASHBOARD");
      expect(history.messages.length).toBe(2);
      expect(history.messages[0].metadata.action).toBe("MEDICINE_OPTIONS");
      expect(history.messages[1].role).toBe("user");
      expect(history.messages[1].content).toBe("Go to Dashboard");
      expect(history.messages[1].metadata.action).toBe("DASHBOARD");
      expect(history.messages[1].metadata.selectedOption).toBe("DASHBOARD");
    });
  });

  describe("Scenario F: Double tap and retry idempotency", () => {
    test("calling GO_TO_DASHBOARD multiple times does not duplicate persisted user message", async () => {
      const appendSpy = jest.spyOn(chatService, "appendChatMessage");
      appendSpy.mockClear();

      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId: "user-f",
        data: {
          currentStep: "MEDICINE_OPTIONS",
          flowMode: "UPLOAD",
          isOnboardingCompleted: false,
        },
      });
      userOnboardingRepository.updateByUserId.mockResolvedValue({});

      const state = {
        userId: "user-f",
        chatSessionId: "session-f",
        flowMode: "UPLOAD",
        currentStep: "MEDICINE_OPTIONS",
        preferredLanguage: "english",
      };

      // Mock listMessages returning empty on first call, then returning the persisted message on second call
      chatSessionRepository.listMessages
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({
          items: [
            {
              role: "user",
              content: "Go to Dashboard",
              metadata: {
                action: "DASHBOARD",
                selectedOption: "DASHBOARD",
                clientMessageId: "client-f-1",
              },
            },
          ],
        });

      // Call 1: initial tap
      await onboardingService.chat(
        "GO_TO_DASHBOARD",
        [],
        state,
        "user-f",
        "session-f",
        "Go to Dashboard",
        "client-f-1",
      );
      expect(appendSpy).toHaveBeenCalledTimes(1);

      // Call 2: concurrent retry / rapid double-tap with same clientMessageId
      await onboardingService.chat(
        "GO_TO_DASHBOARD",
        [],
        state,
        "user-f",
        "session-f",
        "Go to Dashboard",
        "client-f-1",
      );
      // Still only 1 call to appendChatMessage — no duplication!
      expect(appendSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("Scenario E: Existing selectedOption is not accidentally overwritten", () => {
    test("subsequent unrelated calls preserve existing selectedOption in user_onboarding", async () => {
      let savedData = null;
      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId: "user-e",
        data: {
          currentStep: "POST_ONBOARDING",
          isOnboardingCompleted: true,
          selectedOption: "DASHBOARD",
          preferredLanguage: "english",
        },
      });
      userOnboardingRepository.updateByUserId.mockImplementation((uid, update) => {
        savedData = update.data;
        return Promise.resolve({});
      });

      const state = {
        userId: "user-e",
        chatSessionId: "session-e",
        flowMode: "UPLOAD",
        currentStep: "POST_ONBOARDING",
        isOnboardingCompleted: true,
        // selectedOption is undefined in incoming state
      };

      await onboardingService.chat("hello", [], state, "user-e", "session-e");

      expect(savedData.selectedOption).toBe("DASHBOARD");
    });
  });

  describe("Scenario G: Exact pre-onboarding route through ocrService.onboardingChat", () => {
    test("persists DASHBOARD user message and selectedOption even when incoming state is COMPLETE and completed in DB", async () => {
      const appendSpy = jest
        .spyOn(chatService, "appendChatMessage")
        .mockResolvedValue({ id: "msg-g1" });
      appendSpy.mockClear();

      let savedData = null;
      patientRepository.findById.mockResolvedValue({
        id: "user-g",
        firstName: "Shradha",
        lastName: "Chauhan",
      });
      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId: "user-g",
        data: {
          chatSessionId: "session-g",
          currentStep: "POST_ONBOARDING",
          isOnboardingCompleted: true,
          medicationFlowDone: true,
          medicinesConfirmed: true,
          bloodGroupSkipped: false,
          allergiesSkipped: true,
          existingUserData: {
            bloodGroup: "B+",
            allergies: [],
            firstName: "Shradha",
            lastName: "Chauhan",
          },
          preferredLanguage: "gujarati",
        },
      });
      userOnboardingRepository.updateByUserId.mockImplementation((uid, update) => {
        savedData = update.data;
        return Promise.resolve({});
      });
      chatSessionRepository.listMessages.mockResolvedValue({ items: [] });

      const payload = {
        message: "DASHBOARD",
        displayLabel: "ડેશબોર્ડ પર જાઓ",
        fromScreen: "Onboarding",
        clientMessageId: "dash-client-msg-g1",
        sessionId: "session-g",
        state: {
          chatSessionId: "session-g",
          currentStep: "COMPLETE",
          isOnboardingCompleted: true,
          medicationFlowDone: true,
          medicinesConfirmed: true,
          bloodGroupSkipped: false,
          allergiesSkipped: true,
          existingUserData: {
            bloodGroup: "B+",
            allergies: [],
            firstName: "Shradha",
            lastName: "Chauhan",
          },
          preferredLanguage: "gujarati",
        },
        history: [],
      };

      const res = await ocrService.onboardingChat("user-g", payload);

      expect(res.state.selectedOption).toBe("DASHBOARD");
      expect(savedData.selectedOption).toBe("DASHBOARD");
      expect(savedData.isOnboardingCompleted).toBe(true);
      expect(res.state.chatSessionId).toBe("session-g");

      // Verify exactly one user message was appended and zero assistant messages
      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(appendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: "session-g",
          userId: "user-g",
          role: "user",
          content: "ડેશબોર્ડ પર જાઓ",
          metadata: expect.objectContaining({
            action: "DASHBOARD",
            selectedOption: "DASHBOARD",
            clientMessageId: "dash-client-msg-g1",
          }),
        }),
      );
    });

    test("double-tap and network retry through ocrService.onboardingChat prevents duplicate messages", async () => {
      const appendSpy = jest
        .spyOn(chatService, "appendChatMessage")
        .mockResolvedValue({ id: "msg-g2" });
      appendSpy.mockClear();

      patientRepository.findById.mockResolvedValue({
        id: "user-g2",
        firstName: "Shradha",
        lastName: "Chauhan",
      });
      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId: "user-g2",
        data: {
          chatSessionId: "session-g2",
          currentStep: "POST_ONBOARDING",
          isOnboardingCompleted: true,
          medicationFlowDone: true,
          medicinesConfirmed: true,
          bloodGroupSkipped: false,
          allergiesSkipped: true,
          existingUserData: {
            bloodGroup: "B+",
            allergies: [],
            firstName: "Shradha",
            lastName: "Chauhan",
          },
          preferredLanguage: "gujarati",
        },
      });
      userOnboardingRepository.updateByUserId.mockResolvedValue({});

      // First call listMessages returns empty, second returns existing message
      chatSessionRepository.listMessages
        .mockResolvedValueOnce({ items: [] })
        .mockResolvedValueOnce({
          items: [
            {
              role: "user",
              content: "ડેશબોર્ડ પર જાઓ",
              metadata: {
                action: "DASHBOARD",
                selectedOption: "DASHBOARD",
                clientMessageId: "dash-client-msg-g2",
              },
            },
          ],
        });

      const payload = {
        message: "DASHBOARD",
        displayLabel: "ડેશબોર્ડ પર જાઓ",
        fromScreen: "Onboarding",
        clientMessageId: "dash-client-msg-g2",
        sessionId: "session-g2",
        state: {
          chatSessionId: "session-g2",
          currentStep: "COMPLETE",
          isOnboardingCompleted: true,
          medicationFlowDone: true,
          medicinesConfirmed: true,
          bloodGroupSkipped: false,
          allergiesSkipped: true,
          existingUserData: {
            bloodGroup: "B+",
            allergies: [],
            firstName: "Shradha",
            lastName: "Chauhan",
          },
          preferredLanguage: "gujarati",
        },
        history: [],
      };

      // Call 1: initial tap
      await ocrService.onboardingChat("user-g2", payload);
      expect(appendSpy).toHaveBeenCalledTimes(1);

      // Call 2: retry / double-tap
      await ocrService.onboardingChat("user-g2", payload);
      // Still exactly 1 call
      expect(appendSpy).toHaveBeenCalledTimes(1);
    });

    test("SKIP_ONBOARDING does not persist selectedOption='DASHBOARD' in ocrService.onboardingChat", async () => {
      const appendSpy = jest.spyOn(chatService, "appendChatMessage");
      appendSpy.mockClear();

      let savedData = null;
      const validSkippableState = {
        chatSessionId: "session-g3",
        currentStep: "MEDICINE_OPTIONS",
        flowMode: "MANUAL",
        preferredLanguage: "english",
        profileConfirmed: true,
        isOnboardingCompleted: false,
        existingUserData: {
          firstName: "Test",
          lastName: "User",
          dateOfBirth: "1990-01-01",
          gender: "Male",
        },
      };

      patientRepository.findById.mockResolvedValue({
        id: "user-g3",
        firstName: "Test",
        lastName: "User",
      });
      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId: "user-g3",
        data: validSkippableState,
      });
      userOnboardingRepository.updateByUserId.mockImplementation((uid, update) => {
        savedData = update.data;
        return Promise.resolve({});
      });

      const payload = {
        actionType: "SKIP_ONBOARDING",
        message: "Skip",
        sessionId: "session-g3",
        state: validSkippableState,
        history: [],
      };

      const res = await ocrService.onboardingChat("user-g3", payload);

      expect(res.actionType).toBe("SKIP_ONBOARDING");
      expect(savedData.hasSkipped).toBe(true);
      expect(savedData.isOnboardingCompleted).toBe(true);
      expect(savedData.selectedOption).not.toBe("DASHBOARD");
      expect(appendSpy).toHaveBeenCalledTimes(0);
    });
  });
});
