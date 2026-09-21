const medicationService = require("../src/services/medication.service");
const medicationReminderService = require("../src/services/medicationReminder.service");
const patientRepository = require("../src/repositories/patientRepository");
const medicationRepository = require("../src/repositories/medicationRepository");
const authProviderRepository = require("../src/repositories/authProviderRepository");
const chatSessionRepository = require("../src/repositories/chatSessionRepository");
const { onboardingService } = require("../src/services/ai/chat/onboarding.service");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");
jest.mock("../src/repositories/medicationReminderRepository");
jest.mock("../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../src/repositories/userOnboardingRepository");
jest.mock("../src/repositories/authProviderRepository");

describe("Onboarding Review Medicines Flow Tests (Flows A - G)", () => {
  const userId = "test-user-review-flow-1";

  beforeEach(() => {
    jest.clearAllMocks();
    authProviderRepository.findByUserId.mockResolvedValue([]);
    patientRepository.findById.mockResolvedValue({
      id: userId,
      patientCode: "PAT999",
      firstName: "Jane",
      lastName: "Doe",
    });
    patientRepository.updateById.mockResolvedValue({});
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-999" });
    jest.spyOn(chatSessionRepository, "createSession").mockResolvedValue({ id: "sess-999" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // Test 1 (Flow A): Q&A complete + extracted medicines exist -> redirects to REVIEW_MEDICINES_LIST
  test("1 (Flow A): Q&A complete + extracted medicines exist -> redirects to REVIEW_MEDICINES_LIST with medicines listed", async () => {
    const state = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      documentUploaded: true,
      profileConfirmed: true,
      bloodGroupSkipped: true,
      allergiesSkipped: true,
      currentStep: "ASK_ALLERGIES",
      existingUserData: {
        firstName: "Jane",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "female",
      },
      foundMedicines: [
        {
          name: "Amoxicillin 500mg",
          type: "CAPSULE",
          dose: { value: 1, unit: "capsule" },
          frequency: "ONCE",
        },
      ],
    };

    const res = await onboardingService.chat("SKIP", [], state, userId);
    expect(res.action).toBe("REVIEW_MEDICINES_LIST");
    expect(res.medicines).toHaveLength(1);
    expect(res.medicines[0].name).toBe("Amoxicillin 500mg");
  });

  // Test 2 (Flow A): Q&A complete + NO extracted medicines -> existing behavior unchanged (MEDICINE_OPTIONS)
  test("2 (Flow A): Q&A complete + NO extracted medicines -> existing behavior unchanged (no redirect to review list)", async () => {
    const state = {
      preferredLanguage: "english",
      flowMode: "UPLOAD",
      documentUploaded: true,
      profileConfirmed: true,
      bloodGroupSkipped: true,
      allergiesSkipped: true,
      currentStep: "ASK_ALLERGIES",
      existingUserData: {
        firstName: "Jane",
        lastName: "Doe",
        dateOfBirth: "1990-01-01",
        gender: "female",
      },
      foundMedicines: [],
      medicinesToAdd: [],
    };

    const res = await onboardingService.chat("SKIP", [], state, userId);
    expect(res.action).toBe("MEDICINE_OPTIONS");
    expect(res.action).not.toBe("REVIEW_MEDICINES_LIST");
  });

  // Test 3 (Flow B): Confirm on review list -> only selected medicines saved; reminders generated for exactly those
  test("3 (Flow B): Confirm on review list -> only selected medicines saved and reminders created; unselected ignored", async () => {
    const mockMeds = [
      {
        id: "med-1",
        client_med_id: "med-1",
        name: "Aspirin 81mg",
        type: "TABLET",
        selected: true,
        isSaved: false,
      },
      {
        id: "med-2",
        client_med_id: "med-2",
        name: "Ibuprofen 400mg",
        type: "TABLET",
        selected: false,
        isSaved: false,
      },
    ];

    const state = {
      preferredLanguage: "english",
      currentStep: "REVIEW_MEDICINES_LIST",
      medicinesToAdd: mockMeds,
      profileConfirmed: true,
    };

    const bulkCreateSpy = jest
      .spyOn(medicationService, "bulkCreate")
      .mockResolvedValue([{ id: "550e8400-e29b-41d4-a716-446655440001", name: "Aspirin 81mg" }]);
    const reminderSpy = jest
      .spyOn(medicationReminderService, "createReminder")
      .mockResolvedValue({ id: "rem-1" });

    const confirmPayload = JSON.stringify({
      action: "CONFIRM",
      selected: ["med-1"],
    });

    const res = await onboardingService.chat(confirmPayload, [], state, userId);

    expect(bulkCreateSpy).toHaveBeenCalledTimes(1);
    expect(bulkCreateSpy.mock.calls[0][1]).toHaveLength(1);
    expect(bulkCreateSpy.mock.calls[0][1][0].name).toBe("Aspirin 81mg");
    expect(reminderSpy).toHaveBeenCalledTimes(1);
    expect(res.action).toBe("MEDICINE_OPTIONS");
  });

  // Test 4 (Flow C): "Add new" from review list -> form opens and extracted medicines remain in state/displayed
  test("4 (Flow C): 'Add new' opens form and extracted medicines remain in state/displayed", async () => {
    const state = {
      preferredLanguage: "english",
      currentStep: "REVIEW_MEDICINES_LIST",
      medicinesToAdd: [
        { id: "ext-1", name: "Extracted Med 1", type: "TABLET", selected: true, isSaved: false },
      ],
    };

    const res = await onboardingService.chat("ADD", [], state, userId);
    expect(res.action).toBe("ADD_MEDICINE");
    expect(res.renderType).toBe("MEDICINE_FORM");
    expect(res.medicines).toHaveLength(1);
    expect(res.medicines[0].name).toBe("Extracted Med 1");
  });

  // Test 5 (Flow D): "Add & Continue" -> DRAFT_SYNC dispatched/handled; draft holds extracted + added medicines; NO DB write
  test("5 (Flow D): 'Add & Continue' updates draft, resets form, holds accumulated list, zero DB writes", async () => {
    const state = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [
        { id: "ext-1", name: "Extracted Med 1", type: "TABLET", selected: true, isSaved: false },
      ],
    };

    const bulkCreateSpy = jest.spyOn(medicationService, "bulkCreate");

    const addContinuePayload = JSON.stringify({
      action: "ADD_AND_CONTINUE",
      addAndContinue: true,
      medicine: {
        name: "Manually Added Med 1",
        type: "TABLET",
        dose: { count: 1 },
        frequency: "ONCE",
      },
    });

    const res = await onboardingService.chat(addContinuePayload, [], state, userId);

    expect(res.action).toBe("ADD_MEDICINE");
    expect(res.medicines).toHaveLength(2);
    expect(res.medicines.map((m) => m.name)).toContain("Extracted Med 1");
    expect(res.medicines.map((m) => m.name)).toContain("Manually Added Med 1");
    expect(bulkCreateSpy).not.toHaveBeenCalled();
  });

  // Test 6 (Flow D): Multiple "Add & Continue" cycles accumulate correctly
  test("6 (Flow D): Multiple 'Add & Continue' cycles accumulate draft correctly", async () => {
    let state = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [{ id: "doc-1", name: "Doc Med 1", type: "TABLET", isSaved: false }],
    };

    const payload1 = JSON.stringify({
      action: "ADD_AND_CONTINUE",
      addAndContinue: true,
      medicine: { name: "Manual Med 1", type: "TABLET", dose: { count: 1 }, frequency: "ONCE" },
    });

    const res1 = await onboardingService.chat(payload1, [], state, userId);
    state = res1.state;
    expect(state.medicinesToAdd).toHaveLength(2);

    const payload2 = JSON.stringify({
      action: "ADD_AND_CONTINUE",
      addAndContinue: true,
      medicine: { name: "Manual Med 2", type: "TABLET", dose: { count: 1 }, frequency: "TWICE" },
    });

    const res2 = await onboardingService.chat(payload2, [], state, userId);
    expect(res2.state.medicinesToAdd).toHaveLength(3);
    expect(res2.medicines.map((m) => m.name)).toEqual([
      "Doc Med 1",
      "Manual Med 1",
      "Manual Med 2",
    ]);
  });

  // Test 7 (Flow E): "Save Medicines" -> all (extracted + added) saved, reminders generated, MEDICINE_OPTIONS returned, draft cleared
  test("7 (Flow E): 'Save Medicines' saves all accumulated medicines + reminders and returns MEDICINE_OPTIONS", async () => {
    const state = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [{ id: "doc-1", name: "Doc Med 1", type: "TABLET", isSaved: false }],
      openedFromMedicineOptions: true,
    };

    const bulkCreateSpy = jest.spyOn(medicationService, "bulkCreate").mockResolvedValue([
      { id: "550e8400-e29b-41d4-a716-446655440001", name: "Doc Med 1" },
      { id: "550e8400-e29b-41d4-a716-446655440002", name: "Manual Med 1" },
    ]);
    const reminderSpy = jest
      .spyOn(medicationReminderService, "createReminder")
      .mockResolvedValue({ id: "rem-x" });

    const savePayload = JSON.stringify({
      action: "SAVE_MEDICINES",
      saveMedicines: true,
      medicine: { name: "Manual Med 1", type: "TABLET", dose: { count: 1 }, frequency: "ONCE" },
    });

    const res = await onboardingService.chat(savePayload, [], state, userId);

    expect(res.action).toBe("MEDICINE_OPTIONS");
    expect(bulkCreateSpy).toHaveBeenCalledTimes(1);
    expect(bulkCreateSpy.mock.calls[0][1]).toHaveLength(2);
    expect(reminderSpy).toHaveBeenCalledTimes(2);
  });

  // Test 8 (Flow F): Cancel -> MEDICINE_OPTIONS returned, nothing saved, no reminders, draft cleared
  test("8 (Flow F): Cancel returns MEDICINE_OPTIONS, clears unsaved draft, zero DB writes", async () => {
    const state = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [{ id: "draft-1", name: "Draft Med 1", type: "TABLET", isSaved: false }],
    };

    const bulkCreateSpy = jest.spyOn(medicationService, "bulkCreate");

    const res = await onboardingService.chat("CANCEL", [], state, userId);

    expect(res.action).toBe("MEDICINE_OPTIONS");
    expect(res.state.medicinesToAdd).toEqual([]);
    expect(bulkCreateSpy).not.toHaveBeenCalled();
  });

  // Test 9 (Flow G): ADD_MEDICINE from MEDICINE_OPTIONS -> blank form, no old medicines, no redirect to REVIEW_MEDICINES_LIST
  test("9 (Flow G): ADD_MEDICINE from MEDICINE_OPTIONS shows blank form and does not return to REVIEW_MEDICINES_LIST", async () => {
    const state = {
      preferredLanguage: "english",
      currentStep: "MEDICINE_OPTIONS",
      medicinesToAdd: [
        {
          id: "550e8400-e29b-41d4-a716-446655440001",
          name: "Existing Saved Med",
          type: "TABLET",
          isSaved: true,
        },
      ],
    };

    // 1. User selects ADD on MEDICINE_OPTIONS
    const resAdd = await onboardingService.chat("ADD", [], state, userId);
    expect(resAdd.action).toBe("ADD_MEDICINE");
    expect(resAdd.medicines).toEqual([]); // Blank form list

    // 2. User submits form
    // const bulkCreateSpy = jest
    //   .spyOn(medicationService, "bulkCreate")
    //   .mockResolvedValue([
    //     { id: "550e8400-e29b-41d4-a716-446655440002", name: "New Single Med" },
    //   ]);
    // jest.spyOn(medicationReminderService, "createReminder").mockResolvedValue({ id: "rem-y" });

    const submitPayload = JSON.stringify({
      medicine: { name: "New Single Med", type: "TABLET", dose: { count: 1 }, frequency: "ONCE" },
    });

    const resSubmit = await onboardingService.chat(submitPayload, [], resAdd.state, userId);
    expect(resSubmit.action).toBe("MEDICINE_OPTIONS");
    expect(resSubmit.action).not.toBe("REVIEW_MEDICINES_LIST");
  });

  // Test 10 (Edge Cases): Idempotency, duplicate medicine names
  test("10 (Edge Cases): Idempotency check prevents re-saving already saved medicines", async () => {
    const state = {
      preferredLanguage: "english",
      currentStep: "REVIEW_MEDICINES_LIST",
      medicinesToAdd: [
        {
          id: "saved-1",
          name: "Saved Med",
          type: "TABLET",
          selected: true,
          isSaved: true,
          dbId: "550e8400-e29b-41d4-a716-446655440001",
        },
      ],
    };

    const bulkCreateSpy = jest.spyOn(medicationService, "bulkCreate");
    const confirmPayload = JSON.stringify({ action: "CONFIRM", selected: ["saved-1"] });

    const res = await onboardingService.chat(confirmPayload, [], state, userId);
    expect(res.action).toBe("MEDICINE_OPTIONS");
    expect(bulkCreateSpy).not.toHaveBeenCalled();
  });

  // Test 11 (Regression): Non-onboarding ADD_MEDICINE / medicine save / reminder generation behave as before
  test("11 (Regression): Non-onboarding medicationService.createMedication creates medication in DB", async () => {
    patientRepository.findById.mockResolvedValue({
      id: userId,
      patientCode: "PAT999",
    });
    medicationRepository.create.mockResolvedValue({
      id: "550e8400-e29b-41d4-a716-446655440009",
      medicationName: "Direct Med",
    });

    const created = await medicationService.createMedication(
      userId,
      {
        medicationName: "Direct Med",
        medicationType: "TABLET",
        dosePerIntake: 1,
        frequency: "Once Daily",
        medicationSchedule: { Morning: "08:00:00" },
        foodFrequency: "BEFORE_FOOD",
        startDate: new Date().toISOString(),
        totalQuantity: 30,
      },
      { skipDuplicateCheck: true },
    );

    expect(created.id).toBe("550e8400-e29b-41d4-a716-446655440009");
  });

  // Test 12 (Shared Code Safety): medicationReminderService.createReminder validates input schema correctly
  test("12 (Shared Code Safety): medicationReminderService.createReminder fails fast on invalid UUIDs", async () => {
    await expect(
      medicationReminderService.createReminder(userId, { medicationId: "not-a-uuid" }),
    ).rejects.toThrow();
  });
});
