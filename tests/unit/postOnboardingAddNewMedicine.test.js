const ocrService = require("../../src/services/ocr.service");
const patientRepository = require("../../src/repositories/patientRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
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

  test("CONFIRM_MEDICINES with newly added medicine matching existing DB med returns REVIEW_MEDICINES_LIST with conflict details", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user_test_123",
      onboardingCompleted: true,
      preferredLanguage: "english",
    });

    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      userId: "user_test_123",
      data: {
        currentStep: "POST_ONBOARDING",
        isOnboardingCompleted: true,
      },
    });

    // Mock patient's existing DB medication ("testing")
    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([
      {
        id: "db_med_testing_999",
        userId: "user_test_123",
        medicationName: "testing",
        medicationType: "TABLET",
        dosePerIntake: 1,
        frequency: "ONCE_DAILY",
        softDelete: false,
      },
    ]);

    const medsToConfirm = [
      {
        id: "extracted_doc_med_1",
        client_med_id: "extracted_doc_med_1",
        name: "Namcold",
        medicationName: "Namcold",
        medicationType: "TABLET",
        selected: true,
      },
      {
        id: "user_added_med_2",
        client_med_id: "user_added_med_2",
        name: "testing",
        medicationName: "testing",
        medicationType: "TABLET",
        selected: true,
        // No resolution set yet because user just added it in review card
      },
    ];

    const body = {
      actionType: "CONFIRM_MEDICINES",
      actionData: {
        medicines: medsToConfirm,
        selected: ["extracted_doc_med_1", "user_added_med_2"],
      },
      message: "Confirm Selection",
      fromScreen: "Dashboard",
    };

    const response = await ocrService.onboardingChat("user_test_123", body);

    expect(response).toBeDefined();
    // Must return REVIEW_MEDICINES_LIST so user can resolve conflict
    expect(response.actionType).toBe("REVIEW_MEDICINES_LIST");
    expect(response.medicines).toBeDefined();
    expect(response.medicines.length).toBe(2);

    const testingMed = response.medicines.find(
      (m) => (m.name || m.medicationName).toLowerCase() === "testing",
    );
    expect(testingMed).toBeDefined();
    expect(testingMed.hasDuplicate).toBe(true);
    expect(testingMed.isBackendDuplicate).toBe(true);
    expect(testingMed.duplicateInfo?.hasDuplicate).toBe(true);
    expect(testingMed.duplicateInfo?.matchedMedication?.medicationName).toBe("testing");
  });

  test("CONFIRM_MEDICINES with resolved duplicate conflict (KEEP_BOTH) proceeds and confirms", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: "user_test_123",
      onboardingCompleted: true,
      preferredLanguage: "english",
    });

    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      userId: "user_test_123",
      data: {
        currentStep: "POST_ONBOARDING",
        isOnboardingCompleted: true,
      },
    });

    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([
      {
        id: "db_med_testing_999",
        userId: "user_test_123",
        medicationName: "testing",
        medicationType: "TABLET",
        dosePerIntake: 1,
        frequency: "ONCE_DAILY",
        softDelete: false,
      },
    ]);

    const medicationService = require("../../src/services/medication.service");
    jest.spyOn(medicationService, "bulkCreate").mockResolvedValue({
      created: [
        { id: "med_1", medicationName: "Namcold" },
        { id: "med_2", medicationName: "testing" },
      ],
      kept: [],
    });

    const medsToConfirm = [
      {
        id: "extracted_doc_med_1",
        client_med_id: "extracted_doc_med_1",
        name: "Namcold",
        medicationName: "Namcold",
        medicationType: "TABLET",
        selected: true,
      },
      {
        id: "user_added_med_2",
        client_med_id: "user_added_med_2",
        name: "testing",
        medicationName: "testing",
        medicationType: "TABLET",
        selected: true,
        resolution: "KEEP_BOTH", // Resolved by user!
      },
    ];

    const body = {
      actionType: "CONFIRM_MEDICINES",
      actionData: {
        medicines: medsToConfirm,
        selected: ["extracted_doc_med_1", "user_added_med_2"],
      },
      message: "Confirm Selection",
      fromScreen: "Dashboard",
    };

    const response = await ocrService.onboardingChat("user_test_123", body);

    expect(response).toBeDefined();
    expect(response.actionType).toBe("CONFIRM_MEDICINES");
    expect(medicationService.bulkCreate).toHaveBeenCalled();
  });
});
