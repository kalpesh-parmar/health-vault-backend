const ocrService = require("../../src/services/ocr.service");
const medicationService = require("../../src/services/medication.service");
const patientRepository = require("../../src/repositories/patientRepository");
const userOnboardingRepository = require("../../src/repositories/userOnboardingRepository");
const chatSessionRepository = require("../../src/repositories/chatSessionRepository");
const { onboardingService } = require("../../src/services/ai/chat/onboarding.service");

jest.mock("../../src/configs/db", () => ({
  db: {
    select: jest.fn().mockReturnThis(),
    from: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    limit: jest.fn().mockResolvedValue([]),
    insert: jest.fn().mockReturnThis(),
    update: jest.fn().mockReturnThis(),
    set: jest.fn().mockReturnThis(),
    values: jest.fn().mockReturnThis(),
    returning: jest.fn().mockResolvedValue([]),
  },
  pool: {
    end: jest.fn(),
    on: jest.fn(),
  },
}));

jest.mock("../../src/clients/ollamaClient", () => ({
  ollamaClient: {
    chat: jest.fn().mockResolvedValue('{"value": null}'),
  },
}));

jest.mock("../../src/services/ai/chat/chat.service", () => ({
  chatService: {
    createOnboardingSession: jest.fn().mockResolvedValue({ id: "sess-mock-123" }),
    getOrCreateCanonicalSession: jest.fn().mockResolvedValue({ id: "sess-mock-123" }),
    appendMessage: jest.fn().mockResolvedValue({ id: "msg-mock-123" }),
    appendChatMessage: jest.fn().mockResolvedValue({ id: "msg-mock-123" }),
    attachDocumentToSession: jest.fn().mockResolvedValue({}),
  },
}));

describe("Post-Onboarding CONFIRM_MEDICINES Save Robustness & Idempotency", () => {
  const userId = "user-auth-paracetamol-1";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-1" });
    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: userId,
      patientCode: "PAT_PARA_001",
      onboardingCompleted: true,
      preferredLanguage: "english",
    });
    jest.spyOn(userOnboardingRepository, "findByUserId").mockResolvedValue({
      userId,
      data: {
        currentStep: "POST_ONBOARDING",
        isOnboardingCompleted: true,
        medicationFlowDone: true,
        medicinesConfirmed: true,
        medicinesSavedToDb: true,
        medicinesToAdd: [],
      },
    });
    jest.spyOn(userOnboardingRepository, "updateByUserId").mockResolvedValue({});
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("1. Success Scenario: CONFIRM_MEDICINES persists Paracetamol even when FE sends medicinesSavedToDb=true", async () => {
    const bulkCreateSpy = jest.spyOn(medicationService, "bulkCreate").mockResolvedValue({
      created: [
        {
          id: "med-db-para-1",
          userId,
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          dosePerIntake: 1,
          frequency: "Once Daily",
          startDate: "2026-10-14",
          totalQuantity: 10,
        },
      ],
      updated: [],
      kept: [],
      createdCount: 1,
    });

    const body = {
      sessionId: "session-test-para-1",
      actionType: "CONFIRM_MEDICINES",
      message: "CONFIRM_MEDICINES",
      state: {
        isOnboardingCompleted: true,
        medicinesSavedToDb: true, // FE-supplied flag previously caused save to be bypassed!
        medicationFlowDone: true,
      },
      actionData: {
        selected: ["client_med_para_1"],
        medicines: [
          {
            id: "client_med_para_1",
            client_med_id: "client_med_para_1",
            name: "Paracetamol",
            type: "TABLET",
            dose: { count: 1 },
            frequency: "Once Daily",
            medicationSchedule: { morning: "09:00" },
          },
        ],
      },
    };

    const response = await ocrService.onboardingChat(userId, body);

    expect(bulkCreateSpy).toHaveBeenCalledTimes(1);
    expect(bulkCreateSpy).toHaveBeenCalledWith(
      userId,
      expect.arrayContaining([
        expect.objectContaining({
          medicationName: "Paracetamol",
          medicationType: "TABLET",
          dosePerIntake: 1,
        }),
      ]),
    );

    expect(response).toBeDefined();
    expect(response.actionType).toBe("CONFIRM_MEDICINES");
    expect(response.reply).toContain("medication");
  });

  test("2. Validation Failure Scenario: Empty/uncreatable payload returns CONFIRM_MEDICINES_ERROR without state corruption", async () => {
    jest.spyOn(medicationService, "bulkCreate").mockResolvedValue({
      created: [],
      updated: [],
      kept: [],
      createdCount: 0,
    });

    const body = {
      sessionId: "session-test-para-2",
      actionType: "CONFIRM_MEDICINES",
      actionData: {
        selected: ["client_med_invalid"],
        medicines: [
          {
            id: "client_med_invalid",
            name: "Paracetamol",
          },
        ],
      },
      state: {
        isOnboardingCompleted: true,
      },
    };

    const response = await ocrService.onboardingChat(userId, body);

    expect(response).toBeDefined();
    expect(response.actionType).toBe("CONFIRM_MEDICINES_ERROR");
    expect(response.reply).toBeDefined();
  });

  test("3. DB Failure Scenario: bulkCreate throwing an error returns CONFIRM_MEDICINES_ERROR gracefully", async () => {
    jest
      .spyOn(medicationService, "bulkCreate")
      .mockRejectedValue(new Error("Connection terminated unexpectedly"));

    const body = {
      sessionId: "session-test-para-3",
      actionType: "CONFIRM_MEDICINES",
      actionData: {
        selected: ["client_med_para_fail"],
        medicines: [
          {
            id: "client_med_para_fail",
            name: "Paracetamol",
            type: "TABLET",
          },
        ],
      },
      state: {
        isOnboardingCompleted: true,
      },
    };

    let response;
    let thrown = null;
    try {
      response = await ocrService.onboardingChat(userId, body);
    } catch (e) {
      thrown = e;
    }

    if (!thrown) {
      expect(response.actionType).toBe("CONFIRM_MEDICINES_ERROR");
    } else {
      expect(thrown.message).toBe("Connection terminated unexpectedly");
    }
  });

  test("4. Retry Scenario: Re-submitting CONFIRM_MEDICINES when already in DB recognizes existing medicine and succeeds", async () => {
    const existingMed = {
      id: "med-db-para-1",
      userId,
      medicationName: "Paracetamol",
      medicationType: "TABLET",
      dosePerIntake: 1,
      frequency: "Once Daily",
    };

    // Simulate bulkCreate finding existing duplicate on retry and returning kept
    jest.spyOn(medicationService, "bulkCreate").mockResolvedValue({
      created: [],
      updated: [],
      kept: [existingMed],
      createdCount: 0,
      keptCount: 1,
    });

    const body = {
      sessionId: "session-test-para-4",
      actionType: "CONFIRM_MEDICINES",
      actionData: {
        selected: ["client_med_para_1"],
        medicines: [
          {
            id: "client_med_para_1",
            name: "Paracetamol",
            type: "TABLET",
            dose: { count: 1 },
            frequency: "Once Daily",
          },
        ],
      },
      state: {
        isOnboardingCompleted: true,
        medicinesSavedToDb: true,
      },
    };

    const response = await ocrService.onboardingChat(userId, body);

    expect(response).toBeDefined();
    expect(response.actionType).not.toBe("CONFIRM_MEDICINES_ERROR");
  });

  test("5. State Discipline: validMedsToBulkCreate is not empty when medicinesToAdd contains Paracetamol", async () => {
    const testState = {
      currentStep: "REVIEW_MEDICINES_LIST",
      medicinesToAdd: [
        {
          id: "draft_1",
          name: "Paracetamol",
          type: "TABLET",
          dose: { count: 1 },
          selected: true,
        },
      ],
      validMedsToBulkCreate: [],
    };

    const result = await onboardingService.chat(
      JSON.stringify({ action: "SAVE_AND_REVIEW" }),
      [],
      testState,
      userId,
    );

    const resultingState = result.state || testState;
    expect(resultingState.validMedsToBulkCreate).toBeDefined();
    expect(resultingState.validMedsToBulkCreate.length).toBeGreaterThan(0);
    expect(resultingState.validMedsToBulkCreate[0].name).toBe("Paracetamol");
  });
});
