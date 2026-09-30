const ocrService = require("../src/services/ocr.service");
const medicationService = require("../src/services/medication.service");
const patientRepository = require("../src/repositories/patientRepository");
const chatSessionRepository = require("../src/repositories/chatSessionRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
const { chatService } = require("../src/services/ai/chat/chat.service");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");
jest.mock("../src/repositories/chatSessionRepository");
jest.mock("../src/repositories/userOnboardingRepository");
jest.mock("../src/services/medication.service");
jest.mock("../src/services/ai/chat/chat.service", () => ({
  chatService: {
    getOrCreateCanonicalSession: jest.fn(),
  },
}));
jest.mock("../src/configs/db", () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  },
}));

describe("Post-Onboarding Add Medicine Form Historical Refresh & Live-to-Refresh Parity (Phase 25)", () => {
  const userId = "user-phase-25-parity";
  const canonicalSessionId = "canonical-session-25";

  beforeEach(() => {
    jest.clearAllMocks();
    chatService.getOrCreateCanonicalSession.mockResolvedValue({ id: canonicalSessionId });
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-id" });

    patientRepository.findById.mockResolvedValue({
      id: userId,
      patientCode: "PAT-25",
      firstName: "Aarav",
      lastName: "Patel",
      isOnboardingCompleted: true,
      preferredLanguage: "english",
    });

    userOnboardingRepository.findByUserId.mockResolvedValue({
      userId,
      data: {
        isOnboardingCompleted: true,
        currentStep: "POST_ONBOARDING",
        medicinesConfirmed: true,
        medicationFlowDone: true,
      },
    });
    userOnboardingRepository.updateByUserId.mockResolvedValue({});
  });

  describe("Task 25.1: Backend ADD_MEDICINE & SAVE_AND_REVIEW Persistence", () => {
    test("isAddMedicineMsg appends Turn 1 (user Add Medicines) and Turn 2 (assistant ADD_MEDICINE prompt) to canonical session", async () => {
      const response = await ocrService.onboardingChat(userId, {
        message: "Add Medicines",
        actionType: "ADD_MEDICINE",
        fromScreen: "AIChatScreen",
        preferredLanguage: "english",
        history: [],
      });

      expect(response).toBeDefined();
      expect(response.actionType).toBe("ADD_MEDICINE");
      expect(response.sessionId).toBe(canonicalSessionId);

      // Verify that chatSessionRepository.appendMessage was called twice
      expect(chatSessionRepository.appendMessage).toHaveBeenCalledTimes(2);

      // Turn 1: User "Add Medicines"
      const turn1Call = chatSessionRepository.appendMessage.mock.calls[0][0];
      expect(turn1Call.sessionId).toBe(canonicalSessionId);
      expect(turn1Call.role).toBe("user");
      expect(turn1Call.content).toBe("Add Medicines");
      expect(turn1Call.metadata.action).toBe("ADD_MEDICINE");
      expect(turn1Call.metadata.actionType).toBe("ADD_MEDICINE");

      // Turn 2: Assistant prompt
      const turn2Call = chatSessionRepository.appendMessage.mock.calls[1][0];
      expect(turn2Call.sessionId).toBe(canonicalSessionId);
      expect(turn2Call.role).toBe("assistant");
      expect(turn2Call.content).toBe("Please enter the new medication details:");
      expect(turn2Call.metadata.action).toBe("ADD_MEDICINE");
      expect(turn2Call.metadata.actionType).toBe("ADD_MEDICINE");
      expect(turn2Call.metadata.mode).toBe("ACTION");
    });

    test("isAddMedicineMsg with Gujarati language produces localized Turn 1 and Turn 2 content", async () => {
      patientRepository.findById.mockResolvedValue({
        id: userId,
        isOnboardingCompleted: true,
        preferredLanguage: "gujarati",
      });

      const response = await ocrService.onboardingChat(userId, {
        actionType: "ADD_MEDICINE",
        displayLabel: "દવાઓ ઉમેરો",
        fromScreen: "AIChatScreen",
        preferredLanguage: "gujarati",
      });

      expect(response).toBeDefined();
      expect(chatSessionRepository.appendMessage).toHaveBeenCalledTimes(2);

      const turn1Call = chatSessionRepository.appendMessage.mock.calls[0][0];
      expect(turn1Call.content).toBe("દવાઓ ઉમેરો");

      const turn2Call = chatSessionRepository.appendMessage.mock.calls[1][0];
      expect(turn2Call.content).toContain("નવી દવાની વિગતો");
    });

    test("SAVE_AND_REVIEW appends Turn 3 (user Save Medicines) with structured rawValue and Turn 4 (assistant review)", async () => {
      const draftMed = {
        id: "client-med-1",
        name: "Metformin",
        type: "TABLET",
        dose: { count: 1, unit: "TABLET" },
        frequency: "Twice Daily",
      };

      const savePayload = {
        action: "SAVE_AND_REVIEW",
        saveAndReview: true,
        medicines: [draftMed],
      };

      const response = await ocrService.onboardingChat(userId, {
        message: savePayload,
        actionType: "SAVE_AND_REVIEW",
        actionData: savePayload,
        displayLabel: "Save Medicines",
        fromScreen: "AIChatScreen",
        preferredLanguage: "english",
      });

      expect(response).toBeDefined();
      expect(response.actionType).toBe("REVIEW_MEDICINES_LIST");
      expect(response.sessionId).toBe(canonicalSessionId);

      // Verify Turn 3 and Turn 4 were appended
      expect(chatSessionRepository.appendMessage).toHaveBeenCalledTimes(2);

      // Turn 3: User "Save Medicines"
      const turn3Call = chatSessionRepository.appendMessage.mock.calls[0][0];
      expect(turn3Call.sessionId).toBe(canonicalSessionId);
      expect(turn3Call.role).toBe("user");
      expect(turn3Call.content).toBe("Save Medicines");
      expect(turn3Call.metadata.action).toBe("SAVE_AND_REVIEW");
      expect(turn3Call.metadata.actionType).toBe("SAVE_AND_REVIEW");
      expect(turn3Call.metadata.rawValue).toEqual(savePayload);

      // Turn 4: Assistant REVIEW_MEDICINES_LIST
      const turn4Call = chatSessionRepository.appendMessage.mock.calls[1][0];
      expect(turn4Call.sessionId).toBe(canonicalSessionId);
      expect(turn4Call.role).toBe("assistant");
      expect(turn4Call.content).toBe("Please review your medicines:");
      expect(turn4Call.metadata.action).toBe("REVIEW_MEDICINES_LIST");
      expect(turn4Call.metadata.actionType).toBe("REVIEW_MEDICINES_LIST");
      expect(turn4Call.metadata.medicines).toEqual([draftMed]);
    });

    test("Full 6-turn sequence appends all turns in chronological order with zero lost turns", async () => {
      const recordedTurns = [];
      chatSessionRepository.appendMessage.mockImplementation(async (msg) => {
        recordedTurns.push(msg);
        return { id: `msg-${recordedTurns.length}` };
      });

      const draftMed = {
        id: "client-med-99",
        name: "Aspirin",
        type: "TABLET",
        dose: { count: 1 },
        frequency: "Once Daily",
      };

      // Turn 1 & 2: User requests to Add Medicine
      await ocrService.onboardingChat(userId, {
        actionType: "ADD_MEDICINE",
        message: "Add Medicines",
        displayLabel: "Add Medicines",
        fromScreen: "AIChatScreen",
      });

      expect(recordedTurns).toHaveLength(2);
      expect(recordedTurns[0].role).toBe("user");
      expect(recordedTurns[0].metadata.action).toBe("ADD_MEDICINE");
      expect(recordedTurns[1].role).toBe("assistant");
      expect(recordedTurns[1].metadata.action).toBe("ADD_MEDICINE");

      // Turn 3 & 4: User saves the form (SAVE_AND_REVIEW)
      const savePayload = {
        action: "SAVE_AND_REVIEW",
        medicines: [draftMed],
      };
      await ocrService.onboardingChat(userId, {
        actionType: "SAVE_AND_REVIEW",
        actionData: savePayload,
        displayLabel: "Save Medicines",
        fromScreen: "AIChatScreen",
      });

      expect(recordedTurns).toHaveLength(4);
      expect(recordedTurns[2].role).toBe("user");
      expect(recordedTurns[2].content).toBe("Save Medicines");
      expect(recordedTurns[2].metadata.action).toBe("SAVE_AND_REVIEW");
      expect(recordedTurns[2].metadata.rawValue).toEqual(savePayload);
      expect(recordedTurns[3].role).toBe("assistant");
      expect(recordedTurns[3].metadata.action).toBe("REVIEW_MEDICINES_LIST");
      expect(recordedTurns[3].metadata.medicines).toEqual([draftMed]);

      // Turn 5 & 6: User confirms medicines (CONFIRM_MEDICINES)
      medicationService.bulkCreate.mockResolvedValue([
        { id: "db-med-99", medicationName: "Aspirin" },
      ]);

      await ocrService.onboardingChat(userId, {
        actionType: "CONFIRM_MEDICINES",
        actionData: { selected: ["client-med-99"], medicines: [draftMed] },
        displayLabel: "Confirm Selection",
        fromScreen: "AIChatScreen",
      });

      expect(recordedTurns).toHaveLength(6);
      expect(recordedTurns[4].role).toBe("user");
      expect(recordedTurns[4].content).toBe("Confirm Selection");
      expect(recordedTurns[4].metadata.actionType).toBe("CONFIRM_MEDICINES");
      expect(recordedTurns[5].role).toBe("assistant");
      expect(recordedTurns[5].metadata.actionType).toBe("CONFIRM_MEDICINES");
      expect(recordedTurns[5].metadata.isConfirmed).toBe(true);

      // Verify that NO turn in the 6-turn sequence is missing!
      const roles = recordedTurns.map((t) => t.role);
      expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);

      const actions = recordedTurns.map((t) => t.metadata.action || t.metadata.actionType);
      expect(actions).toEqual([
        "ADD_MEDICINE",
        "ADD_MEDICINE",
        "SAVE_AND_REVIEW",
        "REVIEW_MEDICINES_LIST",
        "CONFIRM_MEDICINES",
        "CONFIRM_MEDICINES",
      ]);
    });
  });
});
