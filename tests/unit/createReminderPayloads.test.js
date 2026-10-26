const { validateSchema, createReminderSchema } = require("../../src/validations");
const medicationReminderService = require("../../src/services/medicationReminder.service");
const medicationReminderRepository = require("../../src/repositories/medicationReminderRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const medicationReminderOccurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const medicationReminderController = require("../../src/controllers/medicationReminder.controller");
const { StatusCodes } = require("http-status-codes");

describe("Medication Reminder Create - Payload Polymorphism Tests", () => {
  const mockUserId = "123e4567-e89b-12d3-a456-426614174000";
  const mockMedId1 = "2ac99583-b7bd-4875-b2e9-16bd25976aa7";
  const mockMedId2 = "3bc99583-b7bd-4875-b2e9-16bd25976aa8";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Validation Schema (createReminderSchema)", () => {
    test("should validate direct array of medication ID strings (Frontend batch format)", async () => {
      const payload = [mockMedId1, mockMedId2];
      const result = await validateSchema(createReminderSchema, payload);
      expect(result).toEqual([mockMedId1, mockMedId2]);
    });

    test("should validate single object with medicationId", async () => {
      const payload = { medicationId: mockMedId1 };
      const result = await validateSchema(createReminderSchema, payload);
      expect(result).toEqual({ medicationId: mockMedId1 });
    });

    test("should validate array of objects", async () => {
      const payload = [{ medicationId: mockMedId1 }, { medicationId: mockMedId2 }];
      const result = await validateSchema(createReminderSchema, payload);
      expect(result).toHaveLength(2);
      expect(result[0].medicationId).toBe(mockMedId1);
    });

    test("should validate object with medicationIds array", async () => {
      const payload = { medicationIds: [mockMedId1] };
      const result = await validateSchema(createReminderSchema, payload);
      expect(result).toEqual([mockMedId1]);
    });

    test("should reject invalid non-UUID strings", async () => {
      await expect(validateSchema(createReminderSchema, ["invalid-uuid"])).rejects.toThrow();
    });

    test("should reject empty array", async () => {
      await expect(validateSchema(createReminderSchema, [])).rejects.toThrow();
    });
  });

  describe("Service & Controller Execution", () => {
    const mockMed = {
      id: mockMedId1,
      userId: mockUserId,
      medicationName: "Metformin",
      reminderBeforeMinutes: 5,
      dosePerIntake: 1,
      timezone: "Asia/Kolkata",
      medicationSchedule: { Morning: "08:00:00" },
      startDate: "2026-10-22",
      totalQuantity: 10,
    };

    beforeEach(() => {
      jest.spyOn(medicationRepository, "findById").mockResolvedValue(mockMed);
      jest.spyOn(medicationReminderRepository, "findByMedicationId").mockResolvedValue(null);
      jest.spyOn(medicationReminderRepository, "create").mockResolvedValue({
        id: "rem-1",
        patientId: mockUserId,
        medicationId: mockMedId1,
      });
      jest.spyOn(medicationReminderOccurrenceRepository, "bulkCreate").mockResolvedValue([]);
      jest.spyOn(medicationRepository, "updateById").mockResolvedValue(mockMed);
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    test("medicationReminderService.createReminder handles array payload successfully", async () => {
      const result = await medicationReminderService.createReminder(mockUserId, [mockMedId1]);
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe("rem-1");
    });

    test("medicationReminderController.createReminder returns 201 with array payload", async () => {
      const req = {
        auth: { userId: mockUserId },
        body: [mockMedId1],
      };
      let resStatus = null;
      let resBody = null;
      const res = {
        status: (code) => {
          resStatus = code;
          return res;
        },
        json: (data) => {
          resBody = data;
          return res;
        },
      };

      await medicationReminderController.createReminder(req, res);
      expect(resStatus).toBe(StatusCodes.CREATED);
      expect(resBody.status.statusCode).toBe(StatusCodes.CREATED);
      expect(Array.isArray(resBody.data)).toBe(true);
    });
  });
});
