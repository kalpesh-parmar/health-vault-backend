const medicationReminderService = require("../../src/services/medicationReminder.service");
const medicationRepository = require("../../src/repositories/medicationRepository");
const medicationReminderRepository = require("../../src/repositories/medicationReminderRepository");
const medicationReminderOccurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const { createReminderOrBatchSchema, validateSchema } = require("../../src/validations");
const { NotFoundException } = require("../../src/exceptions/appError");

jest.mock("../../src/repositories/medicationRepository");
jest.mock("../../src/repositories/medicationReminderRepository");
jest.mock("../../src/repositories/medicationReminderOccurrenceRepository");
jest.mock("../../src/utils/reminderOccurrenceGenerator", () => ({
  generateReminderOccurrences: jest.fn().mockReturnValue([
    {
      actualMedicationTime: new Date("2026-10-05T08:00:00.000Z"),
      status: "PENDING",
    },
  ]),
}));

describe("Medication Reminder Batch & Single Creation", () => {
  const userId = "patient-uuid-123";
  const medId1 = "123e4567-e89b-12d3-a456-426614174000";
  const medId2 = "123e4567-e89b-12d3-a456-426614174001";

  const sampleMedication1 = {
    id: medId1,
    userId,
    medicationName: "Paracetamol",
    reminderBeforeMinutes: 10,
    dosePerIntake: 1,
  };

  const sampleMedication2 = {
    id: medId2,
    userId,
    medicationName: "Amoxicillin",
    reminderBeforeMinutes: 15,
    dosePerIntake: 2,
  };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("Validation Schema (createReminderOrBatchSchema)", () => {
    test("validates single object format", async () => {
      const payload = { medicationId: medId1 };
      const validated = await validateSchema(createReminderOrBatchSchema, payload);
      expect(validated).toEqual(payload);
    });

    test("validates single UUID string format", async () => {
      const validated = await validateSchema(createReminderOrBatchSchema, medId1);
      expect(validated).toBe(medId1);
    });

    test("validates array of UUID strings format", async () => {
      const payload = [medId1, medId2];
      const validated = await validateSchema(createReminderOrBatchSchema, payload);
      expect(validated).toEqual(payload);
    });

    test("validates array of objects format", async () => {
      const payload = [{ medicationId: medId1 }, { medicationId: medId2 }];
      const validated = await validateSchema(createReminderOrBatchSchema, payload);
      expect(validated).toEqual(payload);
    });

    test("validates wrapped object with medicationIds array", async () => {
      const payload = { medicationIds: [medId1, medId2] };
      const validated = await validateSchema(createReminderOrBatchSchema, payload);
      expect(validated).toEqual(payload);
    });

    test("rejects invalid UUID format", async () => {
      const payload = { medicationId: "invalid-uuid" };
      await expect(validateSchema(createReminderOrBatchSchema, payload)).rejects.toThrow();
    });
  });

  describe("MedicationReminderService.createReminder", () => {
    test("creates a single reminder when single object payload is provided", async () => {
      medicationRepository.findById.mockResolvedValue(sampleMedication1);
      medicationReminderRepository.findByMedicationId.mockResolvedValue(null);
      medicationReminderRepository.create.mockResolvedValue({
        id: "reminder-1",
        patientId: userId,
        medicationId: medId1,
      });

      const result = await medicationReminderService.createReminder(userId, {
        medicationId: medId1,
      });

      expect(result).toEqual({
        id: "reminder-1",
        patientId: userId,
        medicationId: medId1,
      });
      expect(medicationRepository.findById).toHaveBeenCalledWith(medId1);
      expect(medicationReminderOccurrenceRepository.bulkCreate).toHaveBeenCalled();
      expect(medicationRepository.updateById).toHaveBeenCalledWith(
        medId1,
        expect.objectContaining({ endDate: expect.any(Date) }),
      );
    });

    test("returns existing reminder if idempotency match found for single reminder", async () => {
      const existing = { id: "existing-reminder-1", patientId: userId, medicationId: medId1 };
      medicationRepository.findById.mockResolvedValue(sampleMedication1);
      medicationReminderRepository.findByMedicationId.mockResolvedValue(existing);

      const result = await medicationReminderService.createReminder(userId, {
        medicationId: medId1,
      });

      expect(result).toEqual(existing);
      expect(medicationReminderRepository.create).not.toHaveBeenCalled();
    });

    test("creates multiple reminders when array of medication IDs is provided", async () => {
      medicationRepository.findById
        .mockResolvedValueOnce(sampleMedication1)
        .mockResolvedValueOnce(sampleMedication2);

      medicationReminderRepository.findByMedicationId.mockResolvedValue(null);

      medicationReminderRepository.create
        .mockResolvedValueOnce({ id: "rem-1", medicationId: medId1 })
        .mockResolvedValueOnce({ id: "rem-2", medicationId: medId2 });

      const result = await medicationReminderService.createReminder(userId, [medId1, medId2]);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0].id).toBe("rem-1");
      expect(result[1].id).toBe("rem-2");
      expect(medicationReminderRepository.create).toHaveBeenCalledTimes(2);
    });

    test("creates multiple reminders when object with medicationIds is provided", async () => {
      medicationRepository.findById
        .mockResolvedValueOnce(sampleMedication1)
        .mockResolvedValueOnce(sampleMedication2);

      medicationReminderRepository.findByMedicationId.mockResolvedValue(null);

      medicationReminderRepository.create
        .mockResolvedValueOnce({ id: "rem-1", medicationId: medId1 })
        .mockResolvedValueOnce({ id: "rem-2", medicationId: medId2 });

      const result = await medicationReminderService.createReminder(userId, {
        medicationIds: [medId1, medId2],
      });

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
    });

    test("throws NotFoundException when medication belongs to another user", async () => {
      medicationRepository.findById.mockResolvedValue({
        id: medId1,
        userId: "other-user",
      });

      await expect(
        medicationReminderService.createReminder(userId, { medicationId: medId1 }),
      ).rejects.toThrow(NotFoundException);
    });
  });

  describe("MedicationReminderService.createBatchReminders", () => {
    test("batch creates reminders and returns array of results", async () => {
      medicationRepository.findById
        .mockResolvedValueOnce(sampleMedication1)
        .mockResolvedValueOnce(sampleMedication2);

      medicationReminderRepository.findByMedicationId.mockResolvedValue(null);

      medicationReminderRepository.create
        .mockResolvedValueOnce({ id: "rem-1", medicationId: medId1 })
        .mockResolvedValueOnce({ id: "rem-2", medicationId: medId2 });

      const result = await medicationReminderService.createBatchReminders(userId, [
        { medicationId: medId1 },
        { medicationId: medId2 },
      ]);

      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(2);
      expect(result[0].id).toBe("rem-1");
      expect(result[1].id).toBe("rem-2");
    });
  });
});
