const ocrService = require("../../src/services/ocr.service");
const patientRepository = require("../../src/repositories/patientRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const medicationService = require("../../src/services/medication.service");
const { chatService } = require("../../src/services/ai/chat/chat.service");

describe("Post-Onboarding Add New Medicine Response Alignment (Option A)", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg_mock_123" });
    jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});
    jest.spyOn(userOnboardingRepository, "upsertByUserId").mockResolvedValue({});
    jest.spyOn(patientRepository, "updateById").mockResolvedValue({});
    jest
      .spyOn(chatService, "getOrCreateCanonicalSession")
      .mockResolvedValue({ id: "session_test_123" });
    jest
      .spyOn(medicationService, "bulkCreate")
      .mockImplementation(async (userId, meds) => meds || []);
  });

  test("should return medicines array when user passes addNew: true and medicines in post-onboarding", async () => {
    // Mock user as having completed onboarding
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user_test_123",
      onboardingCompleted: true,
    });

    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      userId: "user_test_123",
      data: {
        currentStep: "POST_ONBOARDING",
        isOnboardingCompleted: true,
        medicationFlowDone: true,
        medicinesConfirmed: true,
      },
    });

    jest.spyOn(chatService, "createSession").mockResolvedValue({
      id: "session_test_123",
    });

    const mockMedicines = [
      {
        id: "doc_med_0",
        client_med_id: "doc_med_0",
        name: "MBSON SL",
        type: "TABLET",
        selected: true,
        source: "OCR",
      },
      {
        id: "client_123",
        client_med_id: "client_123",
        name: "Paracetamol",
        type: "TABLET",
        selected: true,
        source: "MANUAL",
      },
    ];

    const body = {
      message: JSON.stringify({
        addNew: true,
        medicines: mockMedicines,
      }),
      inputState: {
        currentStep: "POST_ONBOARDING",
        isOnboardingCompleted: true,
        medicationFlowDone: true,
        medicinesConfirmed: true,
      },
    };

    const response = await ocrService.onboardingChat("user_test_123", body);

    expect(response).toBeDefined();
    expect(response.actionType).toBe("ADD_MEDICINE");
    expect(response.medicines).toBeDefined();
    expect(Array.isArray(response.medicines)).toBe(true);
    expect(response.medicines.length).toBe(2);
    expect(response.medicines[0].name).toBe("MBSON SL");
    expect(response.medicines[1].name).toBe("Paracetamol");
  });

  test("should fetch medicines from chat_messages metadata when payload carries no medicines in post-onboarding", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user_test_123",
      onboardingCompleted: true,
    });

    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      userId: "user_test_123",
      data: {
        currentStep: "POST_ONBOARDING",
        isOnboardingCompleted: true,
        medicationFlowDone: true,
        medicinesConfirmed: true,
      },
    });

    const mockMedicinesInMetadata = [
      {
        id: "doc_med_meta_0",
        name: "Amoxicillin",
        type: "CAPSULE",
        selected: true,
      },
    ];

    jest.spyOn(chatSessionRepository, "listMessages").mockResolvedValue([
      {
        id: "msg_123",
        role: "assistant",
        metadata: {
          actionType: "ADD_DOCUMENT",
          medicines: mockMedicinesInMetadata,
        },
      },
    ]);

    const body = {
      sessionId: "session_test_123",
      actionType: "ADD_MEDICINE",
      message: "ADD_NEW",
      inputState: {
        currentStep: "POST_ONBOARDING",
        isOnboardingCompleted: true,
        medicationFlowDone: true,
        medicinesConfirmed: true,
      },
    };

    const response = await ocrService.onboardingChat("user_test_123", body);

    expect(response).toBeDefined();
    expect(response.actionType).toBe("ADD_MEDICINE");
    expect(response.medicines).toBeDefined();
    expect(Array.isArray(response.medicines)).toBe(true);
    expect(response.medicines.length).toBe(1);
    expect(response.medicines[0].name).toBe("Amoxicillin");
  });
});
