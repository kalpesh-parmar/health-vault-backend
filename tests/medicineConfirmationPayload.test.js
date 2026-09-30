const { unifiedChatSchema } = require("../src/validations/documentFlowValidation");
const { createMedicationSchema } = require("../src/validations/medicationValidation");
const ocrService = require("../src/services/ocr.service");
const medicationService = require("../src/services/medication.service");
const patientRepository = require("../src/repositories/patientRepository");
const chatSessionRepository = require("../src/repositories/chatSessionRepository");
const userOnboardingRepository = require("../src/repositories/userOnboardingRepository");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");
jest.mock("../src/repositories/chatSessionRepository");
jest.mock("../src/repositories/userOnboardingRepository");
jest.mock("../src/services/medication.service");
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

describe("Unified Medicine Confirmation Payload & State Consistency", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-123" });
    userOnboardingRepository.findByUserId.mockResolvedValue({
      userId: "test-user",
      data: {
        medicinesConfirmed: false,
        medicinesToAdd: [],
      },
    });
    userOnboardingRepository.updateByUserId.mockResolvedValue({});
    userOnboardingRepository.create.mockResolvedValue({});
  });

  describe("Schema Validation (unifiedChatSchema)", () => {
    test("accepts plain object actionData and plain object message", () => {
      const payload = {
        actionType: "CONFIRM_MEDICINES",
        actionData: {
          selected: ["client_1"],
          medicines: [
            {
              id: "client_1",
              name: "Amoxicillin",
              type: "CAPSULE",
              dose: { count: 1 },
              frequency: "Twice Daily",
            },
          ],
        },
        message: {
          selected: ["client_1"],
          medicines: [
            {
              id: "client_1",
              name: "Amoxicillin",
              type: "CAPSULE",
              dose: { count: 1 },
              frequency: "Twice Daily",
            },
          ],
        },
      };

      const result = unifiedChatSchema.safeParse(payload);
      expect(result.success).toBe(true);
      expect(typeof result.data.actionData).toBe("object");
      expect(typeof result.data.message).toBe("object");
    });

    test("accepts plain object actionData and string message", () => {
      const payload = {
        actionType: "CONFIRM_MEDICINES",
        actionData: {
          selected: ["client_1"],
        },
        message: "CONFIRM_MEDICINES",
      };

      const result = unifiedChatSchema.safeParse(payload);
      expect(result.success).toBe(true);
      expect(typeof result.data.actionData).toBe("object");
      expect(result.data.message).toBe("CONFIRM_MEDICINES");
    });

    test("rejects stringified JSON actionData with Expected object, received string", () => {
      const payload = {
        actionType: "CONFIRM_MEDICINES",
        actionData: JSON.stringify({
          selected: ["client_1"],
          medicines: [],
        }),
        message: "CONFIRM_MEDICINES",
      };

      const result = unifiedChatSchema.safeParse(payload);
      expect(result.success).toBe(false);
      const errors = result.error.errors;
      expect(
        errors.some(
          (e) =>
            e.path.includes("actionData") && e.message.includes("Expected object, received string"),
        ),
      ).toBe(true);
    });
  });

  describe("OCR Service Routing & Medication Save Alignment", () => {
    test("CONFIRM_MEDICINES with object payload saves medications and returns consistent state flags", async () => {
      const userId = "user-post-100";
      patientRepository.findById.mockResolvedValue({
        id: userId,
        patientCode: "PAT100",
        firstName: "Jane",
        lastName: "Doe",
        onboardingCompleted: true,
        isOnboardingCompleted: true,
        medicationFlowDone: true,
      });

      medicationService.bulkCreate.mockResolvedValue({
        created: [
          {
            id: "med-db-1",
            userId,
            medicationName: "Metformin 500mg",
            medicationType: "TABLET",
            dosePerIntake: 1,
            frequency: "Twice Daily",
            startDate: "2026-09-24",
            totalQuantity: 30,
          },
        ],
        updated: [],
        kept: [],
        createdCount: 1,
        updatedCount: 0,
        keptCount: 0,
        totalProcessed: 1,
      });

      const confirmObject = {
        selected: ["client_med_1"],
        medicines: [
          {
            id: "client_med_1",
            client_med_id: "client_med_1",
            name: "Metformin 500mg",
            type: "TABLET",
            dose: { count: 1 },
            dosePerIntake: "1",
            frequency: "Twice Daily",
            totalQuantity: 30,
            startDate: "2026-09-24",
            ongoing: true,
          },
        ],
      };

      const result = await ocrService.onboardingChat(userId, {
        message: confirmObject,
        actionType: "CONFIRM_MEDICINES",
        actionData: confirmObject,
        fromScreen: "Dashboard",
        preferredLanguage: "english",
        history: [],
        state: { isOnboardingCompleted: true },
      });

      expect(result).toBeDefined();
      expect(medicationService.bulkCreate).toHaveBeenCalled();

      const resState = result.onboardingState || result.state;
      expect(resState).toBeDefined();
      expect(resState.medicinesConfirmed).toBe(true);
      expect(resState.medicinesSavedToDb).toBe(true);
      expect(resState.medicationFlowDone).toBe(true);
      expect(resState.currentStep).toBe("POST_ONBOARDING");
      expect(userOnboardingRepository.updateByUserId).toHaveBeenCalledWith(
        userId,
        expect.objectContaining({
          data: expect.objectContaining({
            medicinesConfirmed: true,
            medicationFlowDone: true,
            currentStep: "POST_ONBOARDING",
            medicinesToAdd: [],
          }),
        }),
      );
    });

    test("CONFIRM_MEDICINES with 'ONCE DAILY' and string dosePerIntake correctly normalizes and passes createMedicationSchema", async () => {
      const userId = "user-post-102";
      patientRepository.findById.mockResolvedValue({
        id: userId,
        patientCode: "PAT102",
        firstName: "John",
        lastName: "Smith",
        onboardingCompleted: true,
        isOnboardingCompleted: true,
        medicationFlowDone: true,
      });

      medicationService.bulkCreate.mockResolvedValue({
        created: [
          {
            id: "med-db-2",
            userId,
            medicationName: "Paracetamol",
            medicationType: "TABLET",
            dosePerIntake: 1.5,
            frequency: "Once Daily",
            startDate: "2026-09-24",
            totalQuantity: 20,
          },
        ],
        updated: [],
        kept: [],
        createdCount: 1,
        updatedCount: 0,
        keptCount: 0,
        totalProcessed: 1,
      });

      const confirmObject = {
        selected: ["client_med_2"],
        medicines: [
          {
            id: "client_med_2",
            client_med_id: "client_med_2",
            name: "Paracetamol",
            type: "TABLET",
            dose: { count: 1.5 },
            dosePerIntake: "1.5",
            frequency: "ONCE DAILY",
            totalQuantity: 20,
            startDate: "2026-09-24",
            ongoing: true,
          },
        ],
      };

      const result = await ocrService.onboardingChat(userId, {
        message: confirmObject,
        actionType: "CONFIRM_MEDICINES",
        actionData: confirmObject,
        fromScreen: "Dashboard",
        preferredLanguage: "english",
        history: [],
        state: { isOnboardingCompleted: true },
      });

      expect(result).toBeDefined();
      expect(medicationService.bulkCreate).toHaveBeenCalled();

      // Verify that the payload passed to bulkCreate is properly normalized
      // and passes the real createMedicationSchema without throwing Invalid enum value
      const passedList = medicationService.bulkCreate.mock.calls[0][1];
      const passedPayload = passedList[0];
      expect(passedPayload.frequency).toBe("Once Daily");
      expect(passedPayload.dosePerIntake).toBe(1.5);
      expect(typeof passedPayload.dosePerIntake).toBe("number");

      const schemaValidation = createMedicationSchema.safeParse(passedPayload);
      expect(schemaValidation.error).toBeUndefined();
      expect(schemaValidation.success).toBe(true);
    });

    test("CONFIRM_MEDICINES with resolution: 'KEEP_NEW' passes createMedicationSchema without requiring replaceMedicationId", () => {
      const today = new Date();
      const todayStr = today.toISOString().split("T")[0];
      const payload = {
        medicationName: "Amoxicillin",
        medicationType: "CAPSULE",
        dosePerIntake: 1,
        frequency: "Twice Daily",
        startDate: todayStr,
        totalQuantity: 30,
        medicationSchedule: {
          Morning: "09:00:00",
          Night: "21:00:00",
        },
        resolution: "KEEP_NEW",
      };

      const result = createMedicationSchema.safeParse(payload);
      expect(result.success).toBe(true);
      expect(result.data.resolution).toBe("KEEP_NEW");

      // Verify REPLACE without replaceMedicationId fails
      const replacePayload = {
        ...payload,
        resolution: "REPLACE",
      };
      const replaceResult = createMedicationSchema.safeParse(replacePayload);
      expect(replaceResult.success).toBe(false);
      expect(replaceResult.error.errors.some((e) => e.path.includes("replaceMedicationId"))).toBe(
        true,
      );
    });

    test("SAVE_AND_REVIEW with object payload routes to REVIEW_MEDICINES_LIST without chat hijacking", async () => {
      const userId = "user-post-101";
      patientRepository.findById.mockResolvedValue({
        id: userId,
        patientCode: "PAT101",
        firstName: "Jane",
        lastName: "Doe",
        isOnboardingCompleted: true,
      });

      const savePayload = {
        action: "SAVE_AND_REVIEW",
        saveAndReview: true,
        medicines: [
          {
            id: "draft-1",
            name: "Paracetamol",
            type: "TABLET",
            dose: { count: 1 },
            frequency: "Once Daily",
          },
        ],
      };

      const result = await ocrService.onboardingChat(userId, {
        message: savePayload,
        actionType: "SAVE_AND_REVIEW",
        actionData: savePayload,
        fromScreen: "Dashboard",
        preferredLanguage: "english",
        history: [],
      });

      expect(result).toBeDefined();
      const resAction = result.actionType || result.action;
      expect(resAction).toBe("REVIEW_MEDICINES_LIST");
      const resState = result.onboardingState || result.state;
      expect(resState.currentStep).toBe("REVIEW_MEDICINES_LIST");
      expect(resState.medicinesToAdd).toHaveLength(1);
    });

    test("getOnboardingStatus and getOnboardingHistory return COMPLETE / POST_ONBOARDING when patient has confirmed medications", async () => {
      const userId = "user-post-200";
      patientRepository.findById.mockResolvedValue({
        id: userId,
        patientCode: "PAT200",
        firstName: "Alice",
        lastName: "Smith",
        onboardingCompleted: true,
        isOnboardingCompleted: true,
        bloodGroup: "O+",
        allergies: ["Penicillin"],
      });

      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId,
        data: {
          currentStep: "POST_ONBOARDING",
          isOnboardingCompleted: true,
          medicinesConfirmed: true,
          medicationFlowDone: true,
          medicinesToAdd: [],
          foundMedicines: [],
        },
      });

      const statusRes = await ocrService.getOnboardingStatus(userId);
      expect(statusRes.currentStep).toBe("POST_ONBOARDING");
      expect(statusRes.isOnboardingCompleted).toBe(true);

      const historyRes = await ocrService.getOnboardingHistory(userId);
      expect(historyRes.resumableState.currentStep).toBe("POST_ONBOARDING");
      expect(historyRes.resumableState.isOnboardingCompleted).toBe(true);
    });

    test("CONFIRM_MEDICINES followed by getOnboardingHistory preserves single medication record invariant", async () => {
      const userId = "user-single-med";
      patientRepository.findById.mockResolvedValue({
        id: userId,
        patientCode: "PAT300",
        firstName: "Bob",
        lastName: "Taylor",
        onboardingCompleted: true,
        isOnboardingCompleted: true,
        bloodGroup: "A+",
        allergies: [],
        allergiesSkipped: true,
      });

      let storedState = {
        currentStep: "REVIEW_MEDICINES_LIST",
        isOnboardingCompleted: true,
        medicinesConfirmed: false,
        medicationFlowDone: false,
        medicinesToAdd: [{ id: "med-1", name: "Paracetamol" }],
      };

      userOnboardingRepository.findByUserId.mockImplementation(async () => ({
        userId,
        data: storedState,
      }));

      userOnboardingRepository.updateByUserId.mockImplementation(async (uid, update) => {
        storedState = { ...storedState, ...update.data };
        return { userId, data: storedState };
      });

      medicationService.bulkCreate.mockResolvedValue({
        created: [{ id: "med-db-1", userId, medicationName: "Paracetamol" }],
        createdCount: 1,
        updatedCount: 0,
        keptCount: 0,
        totalProcessed: 1,
      });

      const confirmObject = {
        selected: ["med-1"],
        medicines: [
          {
            id: "med-1",
            name: "Paracetamol",
            type: "TABLET",
            frequency: "Once Daily",
            startDate: "2026-09-29",
          },
        ],
      };

      // Step 1: User confirms medicine
      const confirmRes = await ocrService.onboardingChat(userId, {
        message: confirmObject,
        actionType: "CONFIRM_MEDICINES",
        actionData: confirmObject,
        fromScreen: "Dashboard",
        preferredLanguage: "english",
        history: [],
      });

      expect(confirmRes.onboardingState.currentStep).toBe("POST_ONBOARDING");
      expect(confirmRes.onboardingState.medicinesConfirmed).toBe(true);
      expect(confirmRes.onboardingState.medicationFlowDone).toBe(true);
      expect(medicationService.bulkCreate).toHaveBeenCalledTimes(1);

      // Step 2: App reloads / calls getOnboardingHistory
      const historyRes = await ocrService.getOnboardingHistory(userId);
      expect(historyRes.resumableState.currentStep).toBe("POST_ONBOARDING");
      expect(historyRes.resumableState.medicinesConfirmed).toBe(true);
      // Ensure no duplicate bulkCreate was triggered, exactly 1 created med
      expect(medicationService.bulkCreate).toHaveBeenCalledTimes(1);
    });

    test("CONFIRM_MEDICINES appends human-readable localized text to chatSessionRepository and never raw JSON", async () => {
      const userId = "user-localized-test";
      patientRepository.findById.mockResolvedValue({
        id: userId,
        preferredLanguage: "gujarati",
        onboardingCompleted: true,
        isOnboardingCompleted: true,
      });

      userOnboardingRepository.findByUserId.mockResolvedValue({
        userId,
        data: {
          isOnboardingCompleted: true,
          currentStep: "POST_ONBOARDING",
          medicinesConfirmed: false,
          medicinesToAdd: [{ id: "med-1", name: "Paracetamol" }],
        },
      });

      const confirmObject = {
        selected: ["med-1"],
        medicines: [
          {
            id: "med-1",
            name: "Paracetamol",
            type: "TABLET",
            frequency: "Once Daily",
            startDate: "2026-09-29",
          },
        ],
      };

      medicationService.bulkCreate.mockResolvedValue({
        created: [{ id: "med-db-1", userId, medicationName: "Paracetamol" }],
        createdCount: 1,
        updatedCount: 0,
        keptCount: 0,
        totalProcessed: 1,
      });

      // Case 1: Client sends displayLabel
      await ocrService.onboardingChat(userId, {
        message: confirmObject,
        actionType: "CONFIRM_MEDICINES",
        actionData: confirmObject,
        displayLabel: "આગળ વધો",
        fromScreen: "Dashboard",
        preferredLanguage: "gujarati",
        sessionId: "session-test-1",
        history: [],
      });

      const userAppends = chatSessionRepository.appendMessage.mock.calls.filter(
        (call) => call[0].role === "user",
      );
      expect(userAppends.length).toBeGreaterThan(0);
      const lastUserMsg = userAppends[userAppends.length - 1][0];
      expect(lastUserMsg.content).toBe("આગળ વધો");
      expect(lastUserMsg.content).not.toContain("{");
      expect(lastUserMsg.metadata.actionType).toBe("CONFIRM_MEDICINES");
      expect(lastUserMsg.metadata.rawValue).toEqual(confirmObject);

      // Case 2: Client sends tainted stringified JSON in displayLabel
      chatSessionRepository.appendMessage.mockClear();
      await ocrService.onboardingChat(userId, {
        message: confirmObject,
        actionType: "CONFIRM_MEDICINES",
        actionData: confirmObject,
        displayLabel: JSON.stringify(confirmObject),
        fromScreen: "Dashboard",
        preferredLanguage: "gujarati",
        sessionId: "session-test-2",
        history: [],
      });

      const userAppendsTainted = chatSessionRepository.appendMessage.mock.calls.filter(
        (call) => call[0].role === "user",
      );
      expect(userAppendsTainted.length).toBeGreaterThan(0);
      const lastUserMsgTainted = userAppendsTainted[userAppendsTainted.length - 1][0];
      expect(lastUserMsgTainted.content).toBe("આગળ વધો");
      expect(lastUserMsgTainted.content).not.toContain("{");
    });
  });
});
