const ocrService = require("../src/services/ocr.service");
const medicationService = require("../src/services/medication.service");
const medicationReminderService = require("../src/services/medicationReminder.service");
const patientRepository = require("../src/repositories/patientRepository");
const medicationRepository = require("../src/repositories/medicationRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");
const authProviderRepository = require("../src/repositories/authProviderRepository");
const chatSessionRepository = require("../src/repositories/chatSessionRepository");
const { chatService } = require("../src/services/ai/chat/chat.service");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");
jest.mock("../src/repositories/medicationReminderRepository");
jest.mock("../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../src/repositories/userOnboardingRepository");
jest.mock("../src/repositories/authProviderRepository");

describe("Multi-Medicine Persistent Draft Onboarding Flow Tests", () => {
  const userId = "user-multi-med-1";

  beforeEach(() => {
    jest.clearAllMocks();
    authProviderRepository.findByUserId.mockResolvedValue([]);
    patientRepository.findById.mockResolvedValue({
      id: userId,
      patientCode: "PAT100",
      firstName: "Alex",
      lastName: "Smith",
    });
    patientRepository.updateById.mockResolvedValue({});
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-100" });
    jest.spyOn(chatSessionRepository, "createSession").mockResolvedValue({ id: "sess-multi-1" });
    jest.spyOn(chatService, "createOnboardingSession").mockResolvedValue({ id: "sess-multi-1" });
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("Step 1 & 2: ADD_AND_CONTINUE buffers medicine #1 and #2 without DB writes and keeps currentStep = ADD_MEDICINE", async () => {
    let storedDbState = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [],
      profileConfirmed: true,
      isOnboardingCompleted: false,
    };

    userOnboardingRepository.findByUserId.mockImplementation(() =>
      Promise.resolve({ userId, data: storedDbState }),
    );
    userOnboardingRepository.updateByUserId.mockImplementation((uId, payload) => {
      storedDbState = payload.data;
      return Promise.resolve({ userId, data: storedDbState });
    });

    const createMedSpy = jest.spyOn(medicationService, "createMedication");

    // Add Medicine #1 via ADD_AND_CONTINUE
    const med1Payload = {
      message: JSON.stringify({
        action: "ADD_AND_CONTINUE",
        addAndContinue: true,
        medicine: {
          name: "Metformin 500mg",
          type: "TABLET",
          dose: { count: 1 },
          frequency: "Twice Daily",
          medicationSchedule: ["08:00", "20:00"],
          total_quantity: 60,
          foodFrequency: "AFTER_FOOD",
        },
      }),
      state: storedDbState,
    };

    const res1 = await ocrService.onboardingChat(userId, med1Payload, null);

    expect(res1.actionType).toBe("ADD_MEDICINE");
    expect(res1.onboardingState.currentStep).toBe("ADD_MEDICINE");
    expect(res1.onboardingState.medicinesToAdd).toHaveLength(1);
    expect(res1.onboardingState.medicinesToAdd[0].name).toBe("Metformin 500mg");
    expect(res1.onboardingState.medicinesToAdd[0].isSaved).toBe(false);
    expect(res1.totalBuffered).toBe(1);
    // Draft must NOT be written to medications DB yet
    expect(createMedSpy).not.toHaveBeenCalled();

    // Add Medicine #2 via ADD_AND_CONTINUE
    const med2Payload = {
      message: JSON.stringify({
        action: "ADD_AND_CONTINUE",
        addAndContinue: true,
        medicine: {
          name: "Atorvastatin 20mg",
          type: "TABLET",
          dose: { count: 1 },
          frequency: "Once Daily",
          medicationSchedule: ["20:00"],
          total_quantity: 30,
          foodFrequency: "AFTER_FOOD",
        },
      }),
      state: res1.onboardingState,
    };

    const res2 = await ocrService.onboardingChat(userId, med2Payload, null);

    expect(res2.actionType).toBe("ADD_MEDICINE");
    expect(res2.onboardingState.currentStep).toBe("ADD_MEDICINE");
    expect(res2.onboardingState.medicinesToAdd).toHaveLength(2);
    expect(res2.onboardingState.medicinesToAdd[1].name).toBe("Atorvastatin 20mg");
    expect(res2.totalBuffered).toBe(2);
    expect(createMedSpy).not.toHaveBeenCalled();
  });

  test("Step 3: App Restart Resilience - Incoming empty state does NOT wipe stored draft medicines from DB state", async () => {
    const existingDrafts = [
      {
        id: "draft-1",
        name: "Metformin 500mg",
        type: "TABLET",
        selected: true,
        isSaved: false,
      },
      {
        id: "draft-2",
        name: "Atorvastatin 20mg",
        type: "TABLET",
        selected: true,
        isSaved: false,
      },
    ];

    const storedDbState = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: existingDrafts,
      profileConfirmed: true,
      isOnboardingCompleted: false,
    };

    userOnboardingRepository.findByUserId.mockResolvedValue({
      userId,
      data: storedDbState,
    });
    userOnboardingRepository.updateByUserId.mockResolvedValue({});

    // Client restarts app: sends empty medicinesToAdd in state
    const appRestartPayload = {
      message: "hello",
      state: {
        preferredLanguage: "english",
        currentStep: "ADD_MEDICINE",
        medicinesToAdd: [],
      },
    };

    const res = await ocrService.onboardingChat(userId, appRestartPayload, null);

    // Drafts must be preserved from dbState
    expect(res.onboardingState.medicinesToAdd).toHaveLength(2);
    expect(res.onboardingState.medicinesToAdd[0].name).toBe("Metformin 500mg");
    expect(res.onboardingState.medicinesToAdd[1].name).toBe("Atorvastatin 20mg");
  });

  test("Step 4: SAVE_AND_REVIEW transitions to REVIEW_MEDICINES_LIST with all drafts", async () => {
    let storedDbState = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [
        {
          id: "draft-1",
          name: "Metformin 500mg",
          type: "TABLET",
          selected: true,
          isSaved: false,
        },
      ],
      profileConfirmed: true,
      isOnboardingCompleted: false,
    };

    userOnboardingRepository.findByUserId.mockImplementation(() =>
      Promise.resolve({ userId, data: storedDbState }),
    );
    userOnboardingRepository.updateByUserId.mockImplementation((uId, payload) => {
      storedDbState = payload.data;
      return Promise.resolve({ userId, data: storedDbState });
    });

    const saveAndReviewPayload = {
      message: JSON.stringify({
        action: "SAVE_AND_REVIEW",
        saveAndReview: true,
        medicine: {
          name: "Lisinopril 10mg",
          type: "TABLET",
          dose: { count: 1 },
          frequency: "Once Daily",
          medicationSchedule: ["08:00"],
          total_quantity: 30,
        },
      }),
      state: storedDbState,
    };

    const res = await ocrService.onboardingChat(userId, saveAndReviewPayload, null);

    expect(res.actionType).toBe("REVIEW_MEDICINES_LIST");
    expect(res.onboardingState.currentStep).toBe("REVIEW_MEDICINES_LIST");
    expect(res.onboardingState.medicinesToAdd).toHaveLength(2);
    expect(res.medicines).toHaveLength(2);
    expect(res.medicines.map((m) => m.name)).toEqual(["Metformin 500mg", "Lisinopril 10mg"]);
  });

  test("Step 5: Confirm Selection in REVIEW_MEDICINES_LIST creates medications in DB, creates reminders, marks isSaved, and returns to MEDICINE_OPTIONS", async () => {
    const draftMeds = [
      {
        id: "draft-1",
        client_med_id: "draft-1",
        name: "Metformin 500mg",
        medicationName: "Metformin 500mg",
        type: "TABLET",
        medicationType: "TABLET",
        dose: { count: 1 },
        frequency: "Twice Daily",
        medicationSchedule: ["08:00", "20:00"],
        selected: true,
        isSaved: false,
      },
      {
        id: "draft-2",
        client_med_id: "draft-2",
        name: "Lisinopril 10mg",
        medicationName: "Lisinopril 10mg",
        type: "TABLET",
        medicationType: "TABLET",
        dose: { count: 1 },
        frequency: "Once Daily",
        medicationSchedule: ["08:00"],
        selected: true,
        isSaved: false,
      },
    ];

    let storedDbState = {
      preferredLanguage: "english",
      currentStep: "REVIEW_MEDICINES_LIST",
      medicinesToAdd: draftMeds,
      profileConfirmed: true,
      isOnboardingCompleted: false,
    };

    userOnboardingRepository.findByUserId.mockImplementation(() =>
      Promise.resolve({ userId, data: storedDbState }),
    );
    userOnboardingRepository.updateByUserId.mockImplementation((uId, payload) => {
      storedDbState = payload.data;
      return Promise.resolve({ userId, data: storedDbState });
    });

    medicationRepository.bulkInsert.mockResolvedValue([
      { id: "db-med-1", userId, medicationName: "Metformin 500mg" },
      { id: "db-med-2", userId, medicationName: "Lisinopril 10mg" },
    ]);

    const createReminderSpy = jest
      .spyOn(medicationReminderService, "createReminder")
      .mockResolvedValue({ id: "rem-test" });

    const confirmPayload = {
      message: JSON.stringify({ selected: ["draft-1", "draft-2"] }),
      state: storedDbState,
    };

    const res = await ocrService.onboardingChat(userId, confirmPayload, null);

    // Bulk creation must be called
    expect(medicationRepository.bulkInsert).toHaveBeenCalled();
    // Reminder created for each confirmed medicine
    expect(createReminderSpy).toHaveBeenCalledTimes(2);
    // Must return to MEDICINE_OPTIONS
    expect(res.actionType).toBe("MEDICINE_OPTIONS");
    expect(res.onboardingState.currentStep).toBe("MEDICINE_OPTIONS");
    // All confirmed medicines marked isSaved: true with dbId
    expect(res.onboardingState.medicinesToAdd[0].isSaved).toBe(true);
    expect(res.onboardingState.medicinesToAdd[0].dbId).toBe("db-med-1");
    expect(res.onboardingState.medicinesToAdd[1].isSaved).toBe(true);
    expect(res.onboardingState.medicinesToAdd[1].dbId).toBe("db-med-2");

    // Check dynamic option label in MEDICINE_OPTIONS: should say "Add More Medicines"
    const addOption = res.options.find((opt) => opt.key === "ADD");
    expect(addOption).toBeDefined();
    expect(addOption.label).toBe("Add More Medicines");
  });

  test("Step 6: ADD_MORE_MEDICINES from MEDICINE_OPTIONS preserves existing confirmed medicines", async () => {
    const confirmedMeds = [
      {
        id: "db-med-1",
        name: "Metformin 500mg",
        selected: true,
        isSaved: true,
        dbId: "db-med-1",
      },
    ];

    let storedDbState = {
      preferredLanguage: "english",
      currentStep: "MEDICINE_OPTIONS",
      medicinesToAdd: confirmedMeds,
      profileConfirmed: true,
      isOnboardingCompleted: false,
    };

    userOnboardingRepository.findByUserId.mockImplementation(() =>
      Promise.resolve({ userId, data: storedDbState }),
    );
    userOnboardingRepository.updateByUserId.mockImplementation((uId, payload) => {
      storedDbState = payload.data;
      return Promise.resolve({ userId, data: storedDbState });
    });

    const addMorePayload = {
      message: "ADD_MORE_MEDICINES",
      state: storedDbState,
    };

    const res = await ocrService.onboardingChat(userId, addMorePayload, null);

    // Should transition to ADD_MEDICINE without resetting medicinesToAdd
    expect(res.actionType).toBe("ADD_MEDICINE");
    expect(res.onboardingState.currentStep).toBe("ADD_MEDICINE");
    expect(res.onboardingState.medicinesToAdd).toHaveLength(1);
    expect(res.onboardingState.medicinesToAdd[0].name).toBe("Metformin 500mg");
    expect(res.totalBuffered).toBe(1);
  });

  test("Step 7: Cancel Behavior - CANCEL always routes to MEDICINE_OPTIONS (never directly to REVIEW_MEDICINES_LIST)", async () => {
    // Case A: Drafts exist -> CANCEL exits to MEDICINE_OPTIONS
    const stateWithDrafts = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [{ name: "Draft Med", isSaved: false }],
      profileConfirmed: true,
      isOnboardingCompleted: false,
    };

    userOnboardingRepository.findByUserId.mockResolvedValue({
      userId,
      data: stateWithDrafts,
    });
    userOnboardingRepository.updateByUserId.mockResolvedValue({});

    const resWithDrafts = await ocrService.onboardingChat(
      userId,
      { message: "CANCEL", state: stateWithDrafts },
      null,
    );

    expect(resWithDrafts.actionType).toBe("MEDICINE_OPTIONS");
    expect(resWithDrafts.onboardingState.currentStep).toBe("MEDICINE_OPTIONS");

    // Case B: No drafts -> CANCEL exits to MEDICINE_OPTIONS
    const stateNoDrafts = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [],
      profileConfirmed: true,
      isOnboardingCompleted: false,
    };

    userOnboardingRepository.findByUserId.mockResolvedValue({
      userId,
      data: stateNoDrafts,
    });

    const resNoDrafts = await ocrService.onboardingChat(
      userId,
      { message: "CANCEL", state: stateNoDrafts },
      null,
    );

    expect(resNoDrafts.actionType).toBe("MEDICINE_OPTIONS");
    expect(resNoDrafts.onboardingState.currentStep).toBe("MEDICINE_OPTIONS");
  });

  test("Step 8: DRAFT_SYNC (Silent Draft Sync) persists drafts to DB state with isSilent: true and NO chat session messages appended", async () => {
    let storedDbState = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [],
      profileConfirmed: true,
      isOnboardingCompleted: false,
      chatSessionId: "sess-multi-1",
    };

    userOnboardingRepository.findByUserId.mockImplementation(() =>
      Promise.resolve({ userId, data: storedDbState }),
    );
    userOnboardingRepository.updateByUserId.mockImplementation((uId, payload) => {
      storedDbState = payload.data;
      return Promise.resolve({ userId, data: storedDbState });
    });

    const appendSpy = jest.spyOn(chatSessionRepository, "appendMessage");

    const syncPayload = {
      message: JSON.stringify({
        action: "DRAFT_SYNC",
        medicinesToAdd: [
          {
            client_med_id: "med_101",
            id: "med_101",
            name: "Metformin 500mg",
            type: "TABLET",
            dose: { count: 1 },
            frequency: "Twice Daily",
            medicationSchedule: ["08:00", "20:00"],
            selected: true,
            isSaved: false,
          },
        ],
      }),
      isSilent: true,
      state: storedDbState,
    };

    const res = await ocrService.onboardingChat(userId, syncPayload, null);

    expect(res.isSilent).toBe(true);
    expect(res.onboardingState.currentStep).toBe("ADD_MEDICINE");
    expect(res.onboardingState.medicinesToAdd).toHaveLength(1);
    expect(res.onboardingState.medicinesToAdd[0].client_med_id).toBe("med_101");
    expect(res.onboardingState.medicinesToAdd[0].name).toBe("Metformin 500mg");

    // Chat session messages must NOT be appended during silent sync
    expect(appendSpy).not.toHaveBeenCalled();
  });

  test("Step 9: In-place editing via client_med_id updates existing draft without creating duplicate", async () => {
    let storedDbState = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [
        {
          client_med_id: "med_101",
          id: "med_101",
          name: "Metformin 500mg",
          type: "TABLET",
          dose: { count: 1 },
          frequency: "Twice Daily",
          medicationSchedule: ["08:00", "20:00"],
          selected: true,
          isSaved: false,
        },
        {
          client_med_id: "med_102",
          id: "med_102",
          name: "Atorvastatin 20mg",
          type: "TABLET",
          dose: { count: 1 },
          frequency: "Once Daily",
          medicationSchedule: ["20:00"],
          selected: true,
          isSaved: false,
        },
      ],
      profileConfirmed: true,
      isOnboardingCompleted: false,
    };

    userOnboardingRepository.findByUserId.mockImplementation(() =>
      Promise.resolve({ userId, data: storedDbState }),
    );
    userOnboardingRepository.updateByUserId.mockImplementation((uId, payload) => {
      storedDbState = payload.data;
      return Promise.resolve({ userId, data: storedDbState });
    });

    // In-place edit of med_101: change name to Metformin 850mg and dose
    const updatedDrafts = [
      {
        client_med_id: "med_101",
        id: "med_101",
        name: "Metformin 850mg",
        type: "TABLET",
        dose: { count: 2 },
        frequency: "Twice Daily",
        medicationSchedule: ["08:00", "20:00"],
        selected: true,
        isSaved: false,
      },
      {
        client_med_id: "med_102",
        id: "med_102",
        name: "Atorvastatin 20mg",
        type: "TABLET",
        dose: { count: 1 },
        frequency: "Once Daily",
        medicationSchedule: ["20:00"],
        selected: true,
        isSaved: false,
      },
    ];

    const syncPayload = {
      message: JSON.stringify({
        action: "DRAFT_SYNC",
        medicinesToAdd: updatedDrafts,
      }),
      isSilent: true,
      state: storedDbState,
    };

    const res = await ocrService.onboardingChat(userId, syncPayload, null);

    expect(res.onboardingState.medicinesToAdd).toHaveLength(2);
    expect(res.onboardingState.medicinesToAdd[0].client_med_id).toBe("med_101");
    expect(res.onboardingState.medicinesToAdd[0].name).toBe("Metformin 850mg");
    expect(res.onboardingState.medicinesToAdd[0].dose.count).toBe(2);
    expect(res.onboardingState.medicinesToAdd[1].client_med_id).toBe("med_102");
    expect(res.onboardingState.medicinesToAdd[1].name).toBe("Atorvastatin 20mg");
  });

  test("Step 10: SAVE_AND_REVIEW accepting payload.medicines transitions cleanly to REVIEW_MEDICINES_LIST with exact drafts", async () => {
    let storedDbState = {
      preferredLanguage: "english",
      currentStep: "ADD_MEDICINE",
      medicinesToAdd: [],
      profileConfirmed: true,
      isOnboardingCompleted: false,
    };

    userOnboardingRepository.findByUserId.mockImplementation(() =>
      Promise.resolve({ userId, data: storedDbState }),
    );
    userOnboardingRepository.updateByUserId.mockImplementation((uId, payload) => {
      storedDbState = payload.data;
      return Promise.resolve({ userId, data: storedDbState });
    });

    const finalizedDrafts = [
      {
        client_med_id: "med_101",
        id: "med_101",
        name: "Metformin 850mg",
        type: "TABLET",
        dose: { count: 1 },
        frequency: "Twice Daily",
        medicationSchedule: ["08:00", "20:00"],
        selected: true,
        isSaved: false,
      },
      {
        client_med_id: "med_102",
        id: "med_102",
        name: "Atorvastatin 20mg",
        type: "TABLET",
        dose: { count: 1 },
        frequency: "Once Daily",
        medicationSchedule: ["20:00"],
        selected: true,
        isSaved: false,
      },
      {
        client_med_id: "med_103",
        id: "med_103",
        name: "Aspirin 75mg",
        type: "TABLET",
        dose: { count: 1 },
        frequency: "Once Daily",
        medicationSchedule: ["12:00"],
        selected: true,
        isSaved: false,
      },
    ];

    const saveAndReviewPayload = {
      message: JSON.stringify({
        action: "SAVE_AND_REVIEW",
        saveAndReview: true,
        medicines: finalizedDrafts,
      }),
      state: storedDbState,
    };

    const res = await ocrService.onboardingChat(userId, saveAndReviewPayload, null);

    expect(res.actionType).toBe("REVIEW_MEDICINES_LIST");
    expect(res.onboardingState.currentStep).toBe("REVIEW_MEDICINES_LIST");
    expect(res.onboardingState.medicinesToAdd).toHaveLength(3);
    expect(res.medicines).toHaveLength(3);
    expect(res.medicines.map((m) => m.name)).toEqual([
      "Metformin 850mg",
      "Atorvastatin 20mg",
      "Aspirin 75mg",
    ]);
  });
});
