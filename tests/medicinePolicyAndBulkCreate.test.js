const medicationService = require("../src/services/medication.service");
const ocrService = require("../src/services/ocr.service");
const patientRepository = require("../src/repositories/patientRepository");
const chatSessionRepository = require("../src/repositories/chatSessionRepository");
const medicationReminderService = require("../src/services/medicationReminder.service");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");
jest.mock("../src/repositories/chatSessionRepository");
jest.mock("../src/services/medicationReminder.service");
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

describe("Phase 20.5: Medicine Policy Normalization & Canonical bulkCreate()", () => {
  const userId = "test-user-20-5";

  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-test" });
    patientRepository.findById.mockResolvedValue({
      id: userId,
      patientCode: "PAT-205",
      firstName: "Test",
      lastName: "User",
      isOnboardingCompleted: false,
    });
  });

  describe("medicationService.bulkCreate() Policy Resolution", () => {
    test("KEEP_NEW creates a new medication record and creates reminder", async () => {
      const createMedSpy = jest
        .spyOn(medicationService, "createMedication")
        .mockResolvedValue({ id: "med-new-1", medicationName: "Paracetamol" });
      const createRemSpy = jest
        .spyOn(medicationReminderService, "createReminder")
        .mockResolvedValue({ id: "rem-1" });

      const payload = [
        {
          name: "Paracetamol",
          type: "TABLET",
          dosePerIntake: 1,
          frequency: "Once Daily",
          resolution: "KEEP_NEW",
        },
      ];

      const result = await medicationService.bulkCreate(userId, payload);

      expect(createMedSpy).toHaveBeenCalledTimes(1);
      expect(createRemSpy).toHaveBeenCalledWith(userId, { medicationId: "med-new-1" });
      expect(result.createdCount).toBe(1);
      expect(result.updatedCount).toBe(0);
      expect(result.keptCount).toBe(0);
      expect(result.totalProcessed).toBe(1);
      expect(result.created[0].id).toBe("med-new-1");

      createMedSpy.mockRestore();
      createRemSpy.mockRestore();
    });

    test("KEEP_EXISTING does not create a new record and records item as kept", async () => {
      const createMedSpy = jest.spyOn(medicationService, "createMedication");

      const payload = [
        {
          id: "med-existing-1",
          name: "Metformin",
          resolution: "KEEP_EXISTING",
        },
      ];

      const result = await medicationService.bulkCreate(userId, payload);

      expect(createMedSpy).not.toHaveBeenCalled();
      expect(result.createdCount).toBe(0);
      expect(result.updatedCount).toBe(0);
      expect(result.keptCount).toBe(1);
      expect(result.totalProcessed).toBe(1);
      expect(result.kept[0].name).toBe("Metformin");

      createMedSpy.mockRestore();
    });

    test("REPLACE soft-deletes target medication and creates new medication + reminder", async () => {
      const deleteMedSpy = jest
        .spyOn(medicationService, "deleteMedication")
        .mockResolvedValue({ success: true });
      const createMedSpy = jest
        .spyOn(medicationService, "createMedication")
        .mockResolvedValue({ id: "med-replaced-2", medicationName: "Amoxicillin 500mg" });
      const createRemSpy = jest
        .spyOn(medicationReminderService, "createReminder")
        .mockResolvedValue({ id: "rem-2" });

      const payload = [
        {
          name: "Amoxicillin 500mg",
          type: "CAPSULE",
          dosePerIntake: 1,
          frequency: "Twice Daily",
          resolution: "REPLACE",
          replaceMedicationId: "med-old-target-1",
        },
      ];

      const result = await medicationService.bulkCreate(userId, payload);

      expect(deleteMedSpy).toHaveBeenCalledWith("med-old-target-1", userId);
      expect(createMedSpy).toHaveBeenCalledTimes(1);
      expect(createRemSpy).toHaveBeenCalledWith(userId, { medicationId: "med-replaced-2" });
      expect(result.createdCount).toBe(1);
      expect(result.updatedCount).toBe(0);
      expect(result.totalProcessed).toBe(1);

      deleteMedSpy.mockRestore();
      createMedSpy.mockRestore();
      createRemSpy.mockRestore();
    });

    test("EDIT updates target medication in-place without creating duplicate row", async () => {
      const updateMedSpy = jest
        .spyOn(medicationService, "updateMedication")
        .mockResolvedValue({ id: "med-target-3", medicationName: "Paracetamol 650mg" });
      const createMedSpy = jest.spyOn(medicationService, "createMedication");

      const payload = [
        {
          name: "Paracetamol 650mg",
          type: "TABLET",
          dosePerIntake: 1,
          frequency: "Once Daily",
          resolution: "EDIT",
          replaceMedicationId: "med-target-3",
        },
      ];

      const result = await medicationService.bulkCreate(userId, payload);

      expect(updateMedSpy).toHaveBeenCalledWith("med-target-3", userId, expect.any(Object), {
        skipDuplicateCheck: true,
      });
      expect(createMedSpy).not.toHaveBeenCalled();
      expect(result.updatedCount).toBe(1);
      expect(result.createdCount).toBe(0);
      expect(result.keptCount).toBe(0);
      expect(result.totalProcessed).toBe(1);

      updateMedSpy.mockRestore();
      createMedSpy.mockRestore();
    });
  });

  describe("Pre-onboarding SAVE_AND_REVIEW Non-Persistent Staging", () => {
    test("SAVE_AND_REVIEW performs 0 database insertions and keeps flags unconfirmed", async () => {
      const bulkCreateSpy = jest.spyOn(medicationService, "bulkCreate");

      const draftMed = {
        client_med_id: "client_draft_123",
        name: "Paracetamol",
        type: "TABLET",
        dose: { count: 1 },
        dosePerIntake: 1,
        frequency: "Once Daily",
        isSaved: false,
        dbId: null,
      };

      const payload = {
        action: "SAVE_AND_REVIEW",
        saveAndReview: true,
        medicine: draftMed,
        clientMedId: "client_draft_123",
      };

      const result = await ocrService.onboardingChat(userId, {
        message: payload,
        actionType: "SAVE_AND_REVIEW",
        actionData: payload,
        fromScreen: "Onboarding",
        preferredLanguage: "english",
        history: [],
        state: {
          currentStep: "ADD_MEDICINE",
          medicinesFlowStarted: true,
          medicinesConfirmed: false,
          isOnboardingCompleted: false,
          medicinesToAdd: [draftMed],
        },
      });

      expect(result).toBeDefined();
      expect(bulkCreateSpy).not.toHaveBeenCalled();

      const resState = result.onboardingState || result.state;
      expect(resState).toBeDefined();
      expect(resState.medicinesConfirmed).toBe(false);
      expect(resState.medicinesSavedToDb).toBe(false);
      expect(resState.medicationFlowDone).toBe(false);

      // Verify no duplicate medicines staged
      expect(resState.medicinesToAdd).toBeDefined();
      expect(resState.medicinesToAdd.length).toBe(1);
      expect(resState.medicinesToAdd[0].client_med_id).toBe("client_draft_123");

      bulkCreateSpy.mockRestore();
    });

    test("CONFIRM_MEDICINES subsequently persists via bulkCreate and sets completion flags", async () => {
      const bulkCreateSpy = jest.spyOn(medicationService, "bulkCreate").mockResolvedValue({
        created: [{ id: "db-med-1", medicationName: "Paracetamol" }],
        updated: [],
        kept: [],
        createdCount: 1,
        updatedCount: 0,
        keptCount: 0,
        totalProcessed: 1,
      });

      const draftMed = {
        client_med_id: "client_draft_123",
        name: "Paracetamol",
        type: "TABLET",
        dose: { count: 1 },
        dosePerIntake: 1,
        frequency: "Once Daily",
        isSaved: false,
        dbId: null,
      };

      const confirmPayload = {
        selected: ["client_draft_123"],
        medicines: [draftMed],
      };

      const result = await ocrService.onboardingChat(userId, {
        message: confirmPayload,
        actionType: "CONFIRM_MEDICINES",
        actionData: confirmPayload,
        fromScreen: "Onboarding",
        preferredLanguage: "english",
        history: [],
        state: {
          currentStep: "REVIEW_MEDICINES_LIST",
          medicinesFlowStarted: true,
          medicinesConfirmed: false,
          isOnboardingCompleted: false,
          medicinesToAdd: [draftMed],
        },
      });

      expect(result).toBeDefined();
      expect(bulkCreateSpy).toHaveBeenCalledTimes(1);

      const resState = result.onboardingState || result.state;
      expect(resState).toBeDefined();
      expect(resState.medicinesConfirmed).toBe(true);
      expect(resState.medicinesSavedToDb).toBe(true);
      expect(resState.medicationFlowDone).toBe(true);

      // MedicinesToAdd is cleared on confirm
      expect(resState.medicinesToAdd).toEqual([]);

      bulkCreateSpy.mockRestore();
    });
  });
});
