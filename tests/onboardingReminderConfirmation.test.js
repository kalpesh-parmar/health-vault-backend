const ocrService = require("../src/services/ocr.service");
const medicationService = require("../src/services/medication.service");
const medicationReminderService = require("../src/services/medicationReminder.service");
const patientRepository = require("../src/repositories/patientRepository");
const medicationRepository = require("../src/repositories/medicationRepository");
// const medicationReminderRepository = require("../src/repositories/medicationReminderRepository");
// const medicationReminderOccurrenceRepository = require("../src/repositories/medicationReminderOccurrenceRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
const authProviderRepository = require("../src/repositories/authProviderRepository");
const chatSessionRepository = require("../src/repositories/chatSessionRepository");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");
jest.mock("../src/repositories/medicationReminderRepository");
jest.mock("../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../src/repositories/userOnboardingRepository");
jest.mock("../src/repositories/authProviderRepository");

describe("Onboarding & Post-Onboarding Reminder Creation and KEEP_EXISTING Verification Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    authProviderRepository.findByUserId.mockResolvedValue([]);
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-999" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Flow 1 (Onboarding): Confirming extracted medicines MUST trigger medicationReminderService.createReminder for each created medicine", async () => {
    const userId = "user-onboard-rem-1";
    patientRepository.findById.mockResolvedValue({
      id: userId,
      patientCode: "PAT999",
      firstName: "Jane",
      lastName: "Doe",
    });

    userOnboardingRepository.findByUserId.mockResolvedValue({
      userId,
      data: {
        currentStep: "REVIEW_MEDICINES_LIST",
        medicinesToAdd: [
          {
            id: "med-ext-1",
            client_med_id: "med-ext-1",
            name: "Aspirin 100mg",
            type: "TABLET",
            frequency: "ONCE",
            selected: true,
            isSaved: false,
          },
          {
            id: "med-ext-2",
            client_med_id: "med-ext-2",
            name: "Metformin 500mg",
            type: "TABLET",
            frequency: "TWICE",
            selected: true,
            isSaved: false,
          },
        ],
      },
    });

    medicationRepository.bulkInsert.mockResolvedValue([
      { id: "db-med-aspirin", userId, medicationName: "Aspirin 100mg" },
      { id: "db-med-metformin", userId, medicationName: "Metformin 500mg" },
    ]);

    const createReminderSpy = jest
      .spyOn(medicationReminderService, "createReminder")
      .mockResolvedValue({ id: "rem-1" });

    const reqBody = {
      actionType: "CONFIRM_MEDICINES",
      message: "CONFIRM",
      sessionId: "sess-onboard-1",
      state: {
        currentStep: "REVIEW_MEDICINES_LIST",
        medicinesToAdd: [
          {
            id: "med-ext-1",
            client_med_id: "med-ext-1",
            name: "Aspirin 100mg",
            type: "TABLET",
            frequency: "ONCE",
            selected: true,
            isSaved: false,
          },
          {
            id: "med-ext-2",
            client_med_id: "med-ext-2",
            name: "Metformin 500mg",
            type: "TABLET",
            frequency: "TWICE",
            selected: true,
            isSaved: false,
          },
        ],
      },
    };

    await ocrService.onboardingChat(userId, reqBody, null);

    // Verify bulkInsert was called with 2 medicines
    expect(medicationRepository.bulkInsert).toHaveBeenCalled();

    // CRITICAL VERIFICATION: createReminder MUST be called for each created medication
    expect(createReminderSpy).toHaveBeenCalledTimes(2);
    expect(createReminderSpy).toHaveBeenNthCalledWith(1, userId, {
      medicationId: "db-med-aspirin",
    });
    expect(createReminderSpy).toHaveBeenNthCalledWith(2, userId, {
      medicationId: "db-med-metformin",
    });
  });

  test("Flow 3 (KEEP_EXISTING): createMedication with resolution KEEP_EXISTING should return existing active medication without duplicate insertion", async () => {
    const userId = "user-keep-1";
    patientRepository.findById.mockResolvedValue({ id: userId, patientCode: "PAT888" });

    medicationRepository.findAll.mockResolvedValue([
      {
        id: "existing-active-med-id",
        userId,
        medicationName: "Atorvastatin 10mg",
        medicationType: "TABLET",
        softDelete: false,
      },
    ]);

    const result = await medicationService.createMedication(userId, {
      medicationName: "Atorvastatin 10mg",
      medicationType: "TABLET",
      dosePerIntake: 1,
      frequency: "Once Daily",
      startDate: new Date().toISOString().split("T")[0],
      totalQuantity: 30,
      medicationSchedule: { MORNING: "08:00:00" },
      resolution: "KEEP_EXISTING",
    });

    // Verify existing active medication is returned
    expect(result.id).toBe("existing-active-med-id");
    // Verify no new record was created
    expect(medicationRepository.create).not.toHaveBeenCalled();
  });
});
