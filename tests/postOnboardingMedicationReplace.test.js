const ocrService = require("../src/services/ocr.service");
const medicationService = require("../src/services/medication.service");
const medicationReminderService = require("../src/services/medicationReminder.service");
const patientRepository = require("../src/repositories/patientRepository");
const medicationRepository = require("../src/repositories/medicationRepository");
const medicationReminderRepository = require("../src/repositories/medicationReminderRepository");
const medicationReminderOccurrenceRepository = require("../src/repositories/medicationReminderOccurrenceRepository");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");
jest.mock("../src/repositories/medicationReminderRepository");
jest.mock("../src/repositories/medicationReminderOccurrenceRepository");
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

const chatSessionRepository = require("../src/repositories/chatSessionRepository");

describe("Post-Onboarding Add Medicines & Duplicate Replace Flow Tests", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(chatSessionRepository, "appendMessage").mockResolvedValue({ id: "msg-123" });
  });

  describe("Flow 1: Post-onboarding OCR extract & confirm with REPLACE resolution", () => {
    test("should soft-delete older medicine and create new medicine when resolution is REPLACE", async () => {
      const userId = "user-post-1";
      patientRepository.findById.mockResolvedValue({
        id: userId,
        patientCode: "PAT100",
        firstName: "John",
        lastName: "Doe",
      });

      // Mock existing old medication in DB
      medicationRepository.findById.mockImplementation(async (id) => {
        if (id === "old-med-uuid-1") {
          return {
            id: "old-med-uuid-1",
            userId,
            medicationName: "Paracetamol 500mg",
            softDelete: false,
          };
        }
        return null;
      });

      medicationRepository.softDeleteById.mockResolvedValue({
        id: "old-med-uuid-1",
        softDelete: true,
      });
      medicationReminderRepository.findByMedicationId.mockResolvedValue({ id: "rem-old-1" });
      medicationReminderRepository.softDelete.mockResolvedValue(true);
      medicationReminderOccurrenceRepository.softDeleteByReminderId.mockResolvedValue(true);

      medicationRepository.create.mockResolvedValue({
        id: "new-med-uuid-1",
        userId,
        medicationName: "Paracetamol 650mg",
        medicationType: "TABLET",
        dosePerIntake: 1,
        frequency: "ONCE_DAILY",
      });

      jest
        .spyOn(medicationReminderService, "createReminder")
        .mockResolvedValue({ id: "rem-new-1" });

      const reqBody = {
        actionType: "CONFIRM_MEDICINES",
        actionData: {
          medicines: [
            {
              id: "extracted_med_1",
              name: "Paracetamol 650mg",
              medicationName: "Paracetamol 650mg",
              medicationType: "TABLET",
              dosePerIntake: 1,
              frequency: "ONCE_DAILY",
              resolution: "REPLACE",
              replaceMedicationId: "old-med-uuid-1",
              selected: true,
            },
          ],
        },
        message: "Confirm replaced medicine",
        sessionId: "session-post-1",
        state: { isOnboardingCompleted: true },
      };

      const response = await ocrService.onboardingChat(userId, reqBody, null);

      // Verify that old medicine was soft-deleted
      expect(medicationRepository.softDeleteById).toHaveBeenCalledWith("old-med-uuid-1");
      expect(medicationReminderRepository.softDelete).toHaveBeenCalledWith("rem-old-1");
      expect(medicationReminderOccurrenceRepository.softDeleteByReminderId).toHaveBeenCalledWith(
        "rem-old-1",
      );

      // Verify new medicine was created
      expect(medicationRepository.create).toHaveBeenCalled();
      expect(response.actionType).toBe("CONFIRM_MEDICINES");

      jest.restoreAllMocks();
    });
  });

  describe("Flow 2: Manual medicine addition via API with REPLACE resolution", () => {
    const todayStr = new Date().toISOString().split("T")[0];
    const validCreatePayload = {
      medicationName: "Metformin 1000mg",
      medicationType: "TABLET",
      prescribedBy: "Dr. Smith",
      dosePerIntake: 1,
      frequency: "Once Daily",
      foodFrequency: "AFTER_FOOD",
      startDate: todayStr,
      totalQuantity: 60,
      medicationSchedule: { MORNING: "09:00:00" },
    };

    test("createMedication: should soft-delete older medicine and create new medicine when resolution is REPLACE and replaceMedicationId is provided", async () => {
      const userId = "user-manual-1";
      patientRepository.findById.mockResolvedValue({ id: userId, patientCode: "PAT101" });

      medicationRepository.findById.mockImplementation(async (id) => {
        if (id === "old-metformin-id") {
          return {
            id: "old-metformin-id",
            userId,
            medicationName: "Metformin 500mg",
            softDelete: false,
          };
        }
        return null;
      });

      medicationRepository.softDeleteById.mockResolvedValue({
        id: "old-metformin-id",
        softDelete: true,
      });
      medicationReminderRepository.findByMedicationId.mockResolvedValue({
        id: "rem-old-metformin",
      });
      medicationReminderRepository.softDelete.mockResolvedValue(true);
      medicationReminderOccurrenceRepository.softDeleteByReminderId.mockResolvedValue(true);

      medicationRepository.create.mockResolvedValue({
        id: "new-metformin-id",
        userId,
        ...validCreatePayload,
      });

      const result = await medicationService.createMedication(userId, {
        ...validCreatePayload,
        resolution: "REPLACE",
        replaceMedicationId: "old-metformin-id",
      });

      // Assert old medication was deleted
      expect(medicationRepository.softDeleteById).toHaveBeenCalledWith("old-metformin-id");
      expect(medicationReminderRepository.softDelete).toHaveBeenCalledWith("rem-old-metformin");

      // Assert new medication was created
      expect(result.id).toBe("new-metformin-id");
    });
  });
});
