const medicationService = require("../../src/services/medication.service");
const medicationRepository = require("../../src/repositories/medicationRepository");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationReminderRepository = require("../../src/repositories/medicationReminderRepository");
const medicationReminderOccurrenceRepository = require("../../src/repositories/medicationReminderOccurrenceRepository");
const { NotFoundException } = require("../../src/exceptions/appError");

describe("Batch Delete Medications Unit Tests", () => {
  const mockUserId = "123e4567-e89b-12d3-a456-426614174000";
  const mockMedId1 = "987fc53b-140b-486b-8588-e24a49c259bb";
  const mockMedId2 = "a12bc34d-567e-890f-123a-b456c7890def";

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test("should successfully batch delete existing user medications", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({ id: mockUserId });
    jest.spyOn(medicationRepository, "findById").mockImplementation(async (id) => {
      if (id === mockMedId1 || id === mockMedId2) {
        return { id, userId: mockUserId, medicationName: "Test Med" };
      }
      return null;
    });
    jest.spyOn(medicationRepository, "softDeleteById").mockResolvedValue({ id: mockMedId1 });
    jest
      .spyOn(medicationReminderRepository, "findByMedicationId")
      .mockResolvedValue({ id: "rem-1" });
    jest.spyOn(medicationReminderRepository, "softDelete").mockResolvedValue(true);
    jest
      .spyOn(medicationReminderOccurrenceRepository, "softDeleteByReminderId")
      .mockResolvedValue(true);

    const result = await medicationService.batchDeleteMedications(mockUserId, {
      ids: [mockMedId1, mockMedId2],
    });

    expect(result.deletedCount).toBe(2);
    expect(result.deletedIds).toEqual([mockMedId1, mockMedId2]);
    expect(result.notFoundIds).toEqual([]);
    expect(result.totalRequested).toBe(2);
  });

  test("should handle missing patient error", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue(null);

    await expect(
      medicationService.batchDeleteMedications(mockUserId, { ids: [mockMedId1] }),
    ).rejects.toThrow(NotFoundException);
  });

  test("should track notFoundIds if medication doesn't exist or belongs to another user", async () => {
    jest.spyOn(patientRepository, "findById").mockResolvedValue({ id: mockUserId });
    jest.spyOn(medicationRepository, "findById").mockResolvedValue(null);

    const result = await medicationService.batchDeleteMedications(mockUserId, {
      ids: [mockMedId1],
    });

    expect(result.deletedCount).toBe(0);
    expect(result.deletedIds).toEqual([]);
    expect(result.notFoundIds).toEqual([mockMedId1]);
  });
});
