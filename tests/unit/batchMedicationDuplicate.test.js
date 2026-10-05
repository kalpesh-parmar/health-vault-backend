const medicationService = require("../../src/services/medication.service");
const patientRepository = require("../../src/repositories/patientRepository");
const medicationRepository = require("../../src/repositories/medicationRepository");
const medicationReminderService = require("../../src/services/medicationReminder.service");
const { ConflictException } = require("../../src/exceptions/appError");

describe("Batch Medication Duplicate Check Logic (bulkCreate)", () => {
  const userId = "usr-test-batch-dup-123";

  beforeEach(() => {
    jest.restoreAllMocks();

    jest.spyOn(patientRepository, "findById").mockResolvedValue({
      id: userId,
      patientCode: "PAT-1001",
      firstName: "Test",
      lastName: "User",
    });

    jest.spyOn(medicationReminderService, "createReminder").mockResolvedValue({
      id: "rem-100",
    });
  });

  test("should throw ConflictException (409) when batch create item duplicates an active DB medication", async () => {
    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([
      {
        id: "db-med-1",
        userId,
        medicationName: "Paracetamol",
        medicationType: "TABLET",
      },
    ]);

    const batchPayload = [
      {
        medicationName: "Paracetamol",
        type: "TABLET",
        dosePerIntake: 1,
        frequency: "Once Daily",
      },
    ];

    await expect(medicationService.bulkCreate(userId, batchPayload)).rejects.toThrow(
      ConflictException,
    );
  });

  test("should throw ConflictException (409) when batch payload contains duplicate items within the same batch", async () => {
    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([]);
    jest.spyOn(medicationRepository, "create").mockResolvedValue({
      id: "db-med-created-1",
      userId,
      medicationName: "Aspirin",
    });

    const batchPayload = [
      {
        medicationName: "Aspirin",
        type: "TABLET",
        dosePerIntake: 1,
        frequency: "Once Daily",
      },
      {
        medicationName: "Aspirin",
        type: "TABLET",
        dosePerIntake: 1,
        frequency: "Once Daily",
      },
    ];

    await expect(medicationService.bulkCreate(userId, batchPayload)).rejects.toThrow(
      ConflictException,
    );
  });

  test("should skip duplicate check and create medications when options.skipDuplicateCheck is true", async () => {
    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([
      {
        id: "db-med-1",
        userId,
        medicationName: "Paracetamol",
        medicationType: "TABLET",
      },
    ]);

    jest.spyOn(medicationRepository, "create").mockResolvedValue({
      id: "db-med-2",
      userId,
      medicationName: "Paracetamol",
    });

    const batchPayload = [
      {
        medicationName: "Paracetamol",
        type: "TABLET",
        dosePerIntake: 1,
        frequency: "Once Daily",
      },
    ];

    const result = await medicationService.bulkCreate(userId, batchPayload, {
      skipDuplicateCheck: true,
    });

    expect(result.createdCount).toBe(1);
    expect(result.created[0].id).toBe("db-med-2");
  });

  test("should respect resolution KEEP_EXISTING during batch creation", async () => {
    const existingMed = {
      id: "db-med-existing",
      userId,
      medicationName: "Metformin",
      medicationType: "TABLET",
    };
    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([existingMed]);

    const batchPayload = [
      {
        medicationName: "Metformin",
        type: "TABLET",
        resolution: "KEEP_EXISTING",
      },
    ];

    const result = await medicationService.bulkCreate(userId, batchPayload);

    expect(result.createdCount).toBe(0);
    expect(result.keptCount).toBe(1);
  });

  test("should respect resolution REPLACE during batch creation", async () => {
    const existingMed = {
      id: "med-old-123",
      userId,
      medicationName: "Amoxicillin 250mg",
    };
    jest.spyOn(medicationRepository, "findAll").mockResolvedValue([existingMed]);
    jest.spyOn(medicationService, "deleteMedication").mockResolvedValue({ success: true });
    jest.spyOn(medicationRepository, "create").mockResolvedValue({
      id: "med-new-456",
      userId,
      medicationName: "Amoxicillin 500mg",
    });

    const batchPayload = [
      {
        medicationName: "Amoxicillin 500mg",
        type: "CAPSULE",
        frequency: "Once Daily",
        resolution: "REPLACE",
        replaceMedicationId: "med-old-123",
      },
    ];

    const result = await medicationService.bulkCreate(userId, batchPayload);

    expect(medicationService.deleteMedication).toHaveBeenCalledWith("med-old-123", userId);
    expect(result.createdCount).toBe(1);
    expect(result.created[0].id).toBe("med-new-456");
  });
});
