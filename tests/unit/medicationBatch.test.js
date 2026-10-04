const medicationService = require("../../src/services/medication.service");
const medicationReminderService = require("../../src/services/medicationReminder.service");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const { createMedicationOrBatchSchema, validateSchema } = require("../../src/validations");

jest.mock("../../src/repositories/patientRepository");
jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/services/medicationReminder.service");
jest.mock("../../src/configs/db", () => ({
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

describe("Medication Batch & Single Creation with Reminders", () => {
  const userId = "test-user-batch-123";

  beforeEach(() => {
    jest.clearAllMocks();
    patientRepository.findById.mockResolvedValue({
      id: userId,
      patientCode: "PAT-BATCH-1",
      firstName: "John",
      lastName: "Doe",
    });
    medicationRepository.findAll.mockResolvedValue([]);
  });

  describe("Validation Schema (createMedicationOrBatchSchema)", () => {
    test("validates single medication object format", async () => {
      const singleInput = {
        medicationName: "Paracetamol 500mg",
        medicationType: "TABLET",
        frequency: "ONCE_DAILY",
        dosePerIntake: 1,
        medicationSchedule: { Morning: "08:00:00" },
        foodFrequency: "AFTER_FOOD",
        startDate: "2026-10-05",
        totalQuantity: 10,
      };

      const validated = await validateSchema(createMedicationOrBatchSchema, singleInput);
      expect(validated).toBeDefined();
    });

    test("validates array batch of medications", async () => {
      const batchInput = [
        {
          name: "Paracetamol 500mg",
          type: "TABLET",
          frequency: "ONCE",
          dose: { count: 1 },
          total_quantity: 10,
          client_med_id: "med-1",
        },
        {
          name: "Amoxicillin 250mg",
          type: "CAPSULE",
          frequency: "TWICE",
          dose: { count: 1 },
          total_quantity: 14,
          client_med_id: "med-2",
        },
      ];

      const validated = await validateSchema(createMedicationOrBatchSchema, batchInput);
      expect(validated).toBeDefined();
      expect(Array.isArray(validated)).toBe(true);
      expect(validated.length).toBe(2);
    });

    test("validates wrapped object with medications array", async () => {
      const wrappedInput = {
        medications: [
          {
            medicationName: "Ibuprofen 400mg",
            medicationType: "TABLET",
            frequency: "ONCE_DAILY",
            dosePerIntake: 1,
            medicationSchedule: { Morning: "09:00:00" },
            foodFrequency: "AFTER_FOOD",
            startDate: "2026-10-05",
            totalQuantity: 5,
          },
        ],
      };

      const validated = await validateSchema(createMedicationOrBatchSchema, wrappedInput);
      expect(validated).toBeDefined();
      expect(validated.medications).toBeDefined();
      expect(validated.medications.length).toBe(1);
    });
  });

  describe("MedicationService.createMedication() with Batch Arrays and Reminders", () => {
    test("creates multiple medications in array batch and creates reminders for each item", async () => {
      const createdMed1 = { id: "med-db-1", medicationName: "Paracetamol 500mg" };
      const createdMed2 = { id: "med-db-2", medicationName: "Amoxicillin 250mg" };

      medicationRepository.create
        .mockResolvedValueOnce(createdMed1)
        .mockResolvedValueOnce(createdMed2);

      medicationReminderService.createReminder
        .mockResolvedValueOnce({ id: "rem-1", medicationId: "med-db-1" })
        .mockResolvedValueOnce({ id: "rem-2", medicationId: "med-db-2" });

      const batchPayload = [
        {
          name: "Paracetamol 500mg",
          type: "TABLET",
          frequency: "ONCE",
          dose: { count: 1 },
          total_quantity: 10,
          client_med_id: "med-1",
        },
        {
          name: "Amoxicillin 250mg",
          type: "CAPSULE",
          frequency: "TWICE",
          dose: { count: 1 },
          total_quantity: 14,
          client_med_id: "med-2",
        },
      ];

      const result = await medicationService.createMedication(userId, batchPayload);

      expect(result.createdCount).toBe(2);
      expect(result.created[0].id).toBe("med-db-1");
      expect(result.created[1].id).toBe("med-db-2");

      expect(medicationReminderService.createReminder).toHaveBeenCalledTimes(2);
      expect(medicationReminderService.createReminder).toHaveBeenNthCalledWith(1, userId, {
        medicationId: "med-db-1",
      });
      expect(medicationReminderService.createReminder).toHaveBeenNthCalledWith(2, userId, {
        medicationId: "med-db-2",
      });
    });

    test("creates a single medication and generates its reminder", async () => {
      const createdSingleMed = { id: "med-db-single", medicationName: "Vitamin C" };
      medicationRepository.create.mockResolvedValue(createdSingleMed);
      medicationReminderService.createReminder.mockResolvedValue({
        id: "rem-single",
        medicationId: "med-db-single",
      });

      const singlePayload = {
        medicationName: "Vitamin C",
        medicationType: "TABLET",
        frequency: "ONCE_DAILY",
        dosePerIntake: 1,
        medicationSchedule: { Morning: "08:00:00" },
        foodFrequency: "AFTER_FOOD",
        startDate: "2026-10-05",
        totalQuantity: 30,
      };

      const result = await medicationService.createMedication(userId, singlePayload);

      expect(result.id).toBe("med-db-single");
      expect(medicationReminderService.createReminder).toHaveBeenCalledWith(userId, {
        medicationId: "med-db-single",
      });
    });
  });
});
