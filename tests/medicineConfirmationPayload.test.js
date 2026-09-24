const { unifiedChatSchema } = require("../src/validations/documentFlowValidation");
const ocrService = require("../src/services/ocr.service");
const medicationService = require("../src/services/medication.service");
const patientRepository = require("../src/repositories/patientRepository");
const chatSessionRepository = require("../src/repositories/chatSessionRepository");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");
jest.mock("../src/repositories/chatSessionRepository");
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

      medicationService.createMedication.mockResolvedValue({
        id: "med-db-1",
        userId,
        medicationName: "Metformin 500mg",
        medicationType: "TABLET",
        dosePerIntake: "1",
        frequency: "Twice Daily",
        startDate: "2026-09-24",
        totalQuantity: 30,
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
      expect(medicationService.createMedication).toHaveBeenCalled();

      const resState = result.onboardingState || result.state;
      expect(resState).toBeDefined();
      expect(resState.medicinesConfirmed).toBe(true);
      expect(resState.medicinesSavedToDb).toBe(true);
      expect(resState.medicationFlowDone).toBe(true);
      expect(resState.isOnboardingCompleted).toBe(true);
      expect(resState.currentStep).toBe("MEDICINE_OPTIONS");
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
  });
});
