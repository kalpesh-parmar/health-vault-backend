const ocrService = require("../../src/services/ocr.service");
const patientRepository = require("../../src/repositories/patientRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const { chatService } = require("../../src/services/ai/chat/chat.service");

describe("Post-Onboarding Add New Medicine Response Alignment (Option A)", () => {
  beforeEach(() => {
    jest.restoreAllMocks();
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
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg_456" });

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

  test("SAVE_AND_REVIEW deduplicates multiple client representations of the same extracted document medication and avoids false in-batch conflict", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user_test_123",
      onboardingCompleted: true,
      preferredLanguage: "gujarati",
    });

    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      userId: "user_test_123",
      data: {
        currentStep: "REVIEW_MEDICINES_LIST",
        isOnboardingCompleted: true,
        medicinesToAdd: [],
      },
    });

    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg_789" });

    // Payload containing duplicate client-side representations of the same extracted doc medication
    // (one with doc uuid id and one with doc_med_1 id) plus a newly added medication "Gggg"
    const duplicateDocMedAndManualMed = [
      {
        id: "a5126d5b-e6f2-4cab-8ea0-b549d6863b60-med-0-Namcoldaf5ml",
        documentId: "a5126d5b-e6f2-4cab-8ea0-b549d6863b60",
        documentName: "Media (4).jpg",
        name: "Namcold af 5 ml",
        medicineType: "TABLET",
        dosage: "5",
        dosageUnit: "ml",
        frequency: "As directed",
        timing: "After Food",
        totalQuantity: 10,
        selected: true,
      },
      {
        id: "doc_med_1",
        client_med_id: "doc_med_1",
        name: "namcold af 5 ml",
        medicationName: "namcold af 5 ml",
        medicationType: "TABLET",
        type: "TABLET",
        dosePerIntake: 5,
        frequency: "ONCE",
        foodFrequency: "AFTER_FOOD",
        totalQuantity: 1,
        selected: true,
      },
      {
        id: "client_1792736674300_j6omepg",
        client_med_id: "client_1792736674300_j6omepg",
        name: "Gggg",
        medicationName: "Gggg",
        type: "TABLET",
        medicationType: "TABLET",
        dosePerIntake: 1,
        frequency: "Twice Daily",
        totalQuantity: 5,
        source: "MANUAL",
        selected: true,
      },
    ];

    const body = {
      actionType: "SAVE_AND_REVIEW",
      actionData: {
        action: "SAVE_AND_REVIEW",
        saveAndReview: true,
        medicines: duplicateDocMedAndManualMed,
      },
      preferredLanguage: "gujarati",
      fromScreen: "Dashboard",
    };

    const response = await ocrService.onboardingChat("user_test_123", body);

    expect(response).toBeDefined();
    expect(response.actionType).toBe("REVIEW_MEDICINES_LIST");
    expect(response.medicines).toBeDefined();
    expect(Array.isArray(response.medicines)).toBe(true);

    // Exactly 2 medicines: 1 Namcold af 5 ml and 1 Gggg (duplicate Namcold collapsed)
    expect(response.medicines.length).toBe(2);

    const namcold = response.medicines.find((m) =>
      (m.name || m.medicationName).toLowerCase().includes("namcold"),
    );
    const gggg = response.medicines.find((m) =>
      (m.name || m.medicationName).toLowerCase().includes("gggg"),
    );

    expect(namcold).toBeDefined();
    expect(gggg).toBeDefined();

    // Neither should have a false duplicate conflict!
    expect(namcold.duplicateInfo?.hasDuplicate).toBeFalsy();
    expect(gggg.duplicateInfo?.hasDuplicate).toBeFalsy();
  });
});
