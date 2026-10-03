const { onboardingService } = require("../../src/services/ai/chat/onboarding.service");
const patientRepository = require("../../src/repositories/patientRepository");
const authProviderRepository = require("../../src/repositories/authProviderRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const { chatService } = require("../../src/services/ai/chat/chat.service");

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/authProviderRepository");
jest.mock("../../src/repositories/userOnboardingRepository");
jest.mock("../../src/services/ai/chat/chat.service");

describe("ASK_ALLERGIES Chat Answer & Merge Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authProviderRepository.findByUserId.mockResolvedValue(null);
    userOnboardingRepository.findByUserId.mockResolvedValue(null);
    userOnboardingRepository.updateByUserId.mockResolvedValue(null);
    userOnboardingRepository.create.mockResolvedValue(null);
    chatService.appendChatMessage.mockResolvedValue({ id: "msg-123", createdAt: new Date() });
    chatService.sendMessage.mockResolvedValue({
      answer: "Symptoms of diabetes include increased thirst and frequent urination.",
      suggestedQuestions: ["How is diabetes diagnosed?"],
    });
  });

  test("should merge existing DB allergies and new ASK_ALLERGIES chat answer and return MEDICINE_OPTIONS", async () => {
    const userId = "test-user-uuid-123";
    patientRepository.findById.mockResolvedValue({
      id: userId,
      firstName: "Shraddha",
      lastName: "Chauhan",
      dateOfBirth: "1995-05-15",
      gender: "female",
      allergies: ["Ibuprofen"],
      bloodGroup: "B+",
    });
    patientRepository.updateById.mockResolvedValue({ id: userId });

    const state = {
      chatSessionId: "session-123",
      currentStep: "ASK_ALLERGIES",
      flowMode: "MANUAL",
      preferredLanguage: "english",
      profileConfirmed: true,
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "1995-05-15",
        gender: "female",
        bloodGroup: "B+",
        allergies: ["Ibuprofen"],
      },
    };

    const message = JSON.stringify({
      action: "ASK_ALLERGIES",
      allergies: ["Ibuprofen", "Aspirin", "Dust"],
    });

    const result = await onboardingService.chat(
      message,
      [],
      state,
      userId,
      "session-123",
      "Ibuprofen, Aspirin, Dust",
    );

    expect(patientRepository.updateById).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        allergies: ["Ibuprofen", "Aspirin", "Dust"],
      }),
    );
    expect(result.action).toBe("MEDICINE_OPTIONS");
    expect(result.action).not.toBe("NORMAL_CHAT");
    expect(result.message).not.toContain("haven't uploaded any medical reports");
  });

  test("should NOT save second response as an allergy after ASK_ALLERGIES has been answered", async () => {
    const userId = "test-user-uuid-999";
    const ocrService = require("../../src/services/ocr.service");
    patientRepository.findById.mockResolvedValue({
      id: userId,
      firstName: "Shraddha",
      lastName: "Chauhan",
      dateOfBirth: "1995-05-15",
      gender: "female",
      allergies: ["Aspirin", "Penicillin", "Dust"],
    });
    userOnboardingRepository.findByUserId.mockResolvedValue({
      userId,
      data: {
        chatSessionId: "session-999",
        currentStep: "MEDICINE_OPTIONS",
        allergiesSkipped: true,
        existingUserData: {
          allergies: ["Aspirin", "Penicillin", "Dust"],
        },
      },
    });
    patientRepository.updateById.mockResolvedValue({ id: userId });

    const questionMsg = "What are symptoms of diabetes?";

    const result = await ocrService.onboardingChat(userId, {
      message: questionMsg,
      sessionId: "session-999",
      actionType: "ASK_ALLERGIES",
    });

    if (patientRepository.updateById.mock.calls.length > 0) {
      const calls = patientRepository.updateById.mock.calls;
      for (const call of calls) {
        if (call[1] && Array.isArray(call[1].allergies)) {
          expect(call[1].allergies).not.toContain("What are symptoms of diabetes?");
        }
      }
    }

    expect(result.reply).toBe(
      "Symptoms of diabetes include increased thirst and frequent urination.",
    );
  });

  test("should route to REVIEW_MEDICINES_LIST if extracted document medicines are present when answering ASK_ALLERGIES", async () => {
    const userId = "test-user-uuid-456";
    patientRepository.findById.mockResolvedValue({
      id: userId,
      firstName: "Shraddha",
      lastName: "Chauhan",
      dateOfBirth: "1995-05-15",
      gender: "female",
      allergies: [],
    });
    patientRepository.updateById.mockResolvedValue({ id: userId });

    const state = {
      chatSessionId: "session-456",
      currentStep: "ASK_ALLERGIES",
      flowMode: "UPLOAD",
      preferredLanguage: "english",
      profileConfirmed: true,
      medicinesConfirmed: false,
      foundMedicines: [
        { name: "Paracetamol", dose: "500mg" },
        { name: "Amoxicillin", dose: "250mg" },
      ],
      existingUserData: {
        firstName: "Shraddha",
        lastName: "Chauhan",
        dateOfBirth: "1995-05-15",
        gender: "female",
        bloodGroup: "A+",
        allergies: [],
      },
    };

    const message = JSON.stringify({
      action: "ASK_ALLERGIES",
      allergies: ["Penicillin"],
    });

    const result = await onboardingService.chat(
      message,
      [],
      state,
      userId,
      "session-456",
      "Penicillin",
    );

    expect(patientRepository.updateById).toHaveBeenCalledWith(
      userId,
      expect.objectContaining({
        allergies: ["Penicillin"],
      }),
    );
    expect(result.action).toBe("REVIEW_MEDICINES_LIST");
    expect(result.action).not.toBe("NORMAL_CHAT");
  });

  test("should answer health-related question when asked at MEDICINE_OPTIONS step instead of repeating options", async () => {
    const userId = "test-user-uuid-789";
    const state = {
      chatSessionId: "session-789",
      currentStep: "MEDICINE_OPTIONS",
      flowMode: "MANUAL",
      preferredLanguage: "english",
    };

    const healthQuestion = "What should I take for headache?";

    const result = await onboardingService.chat(healthQuestion, [], state, userId, "session-789");

    expect(chatService.sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        question: "What should I take for headache?",
      }),
    );
    expect(result.action).toBe("NORMAL_CHAT");
  });
});
