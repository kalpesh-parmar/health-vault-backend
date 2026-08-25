const medicationService = require("../src/services/medication.service");
const patientRepository = require("../src/repositories/patientRepository");
const medicationRepository = require("../src/repositories/medicationRepository");
const medicationReminderRepository = require("../src/repositories/medicationReminderRepository");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");
jest.mock("../src/repositories/medicationReminderRepository");
jest.mock("../src/repositories/medicationReminderOccurrenceRepository");

describe("MedicationService - checkDuplicateMedication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test("should throw NotFoundException if patient does not exist", async () => {
    patientRepository.findById.mockResolvedValue(null);

    await expect(
      medicationService.checkDuplicateMedication("invalid-user-id", {
        medicationName: "Paracetamol",
      }),
    ).rejects.toThrow();
  });

  test("should return hasDuplicate = true with EXACT_DUPLICATE when exact match found", async () => {
    patientRepository.findById.mockResolvedValue({ id: "user-1", patientCode: "PAT001" });
    medicationRepository.findAll.mockResolvedValue([
      {
        id: "med-1",
        userId: "user-1",
        medicationName: "Dolo 650",
        softDelete: false,
      },
    ]);

    const result = await medicationService.checkDuplicateMedication("user-1", {
      medicationName: "Tab. Dolo 650mg",
    });

    expect(result.hasDuplicate).toBe(true);
    expect(result.conflictType).toBe("EXACT_DUPLICATE");
    expect(result.matchedMedication.id).toBe("med-1");
    expect(result.suggestedActions).toHaveLength(4);
  });

  test("should return hasDuplicate = true with SIMILAR_NAME when similar match found", async () => {
    patientRepository.findById.mockResolvedValue({ id: "user-1", patientCode: "PAT001" });
    medicationRepository.findAll.mockResolvedValue([
      {
        id: "med-2",
        userId: "user-1",
        medicationName: "Paracetamol Extra",
        softDelete: false,
      },
    ]);

    const result = await medicationService.checkDuplicateMedication("user-1", {
      medicationName: "Paracetamol",
    });

    expect(result.hasDuplicate).toBe(true);
    expect(result.conflictType).toBe("SIMILAR_NAME");
    expect(result.matchedMedication.id).toBe("med-2");
  });

  test("should return hasDuplicate = false when no matching active medication exists", async () => {
    patientRepository.findById.mockResolvedValue({ id: "user-1", patientCode: "PAT001" });
    medicationRepository.findAll.mockResolvedValue([
      {
        id: "med-3",
        userId: "user-1",
        medicationName: "Metformin 500mg",
        softDelete: false,
      },
    ]);

    const result = await medicationService.checkDuplicateMedication("user-1", {
      medicationName: "Amoxicillin",
    });

    expect(result.hasDuplicate).toBe(false);
    expect(result.conflictType).toBeNull();
    expect(result.matchedMedication).toBeNull();
    expect(result.suggestedActions).toHaveLength(0);
  });

  describe("checkDuplicateMedicationsBatch", () => {
    test("should check duplicates for multiple medicines in batch", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "med-1",
          userId: "user-1",
          medicationName: "Metformin 500mg Tablet",
          softDelete: false,
        },
      ]);

      const batchInput = [
        { name: "Metformin 500mg Tablet", type: "TABLET" },
        { name: "Amoxicillin 250mg", type: "CAPSULE" },
      ];

      const results = await medicationService.checkDuplicateMedicationsBatch("user-1", batchInput);

      expect(results).toHaveLength(2);
      expect(results[0].duplicateInfo.hasDuplicate).toBe(true);
      expect(results[0].duplicateInfo.conflictType).toBe("EXACT_DUPLICATE");
      expect(results[0].duplicateInfo.matchedMedication.id).toBe("med-1");
      expect(results[1].duplicateInfo.hasDuplicate).toBe(false);
    });

    test("should detect in-batch duplicates within extracted list", async () => {
      medicationRepository.findAll.mockResolvedValue([]);

      const batchInput = [
        { name: "Aspirin 100mg", type: "TABLET", client_med_id: "med_a" },
        { name: "Aspirin 100mg", type: "TABLET", client_med_id: "med_b" },
      ];

      const results = await medicationService.checkDuplicateMedicationsBatch("user-1", batchInput);

      expect(results).toHaveLength(2);
      expect(results[0].duplicateInfo.hasDuplicate).toBe(true);
      expect(results[0].duplicateInfo.conflictType).toBe("EXACT_DUPLICATE");
    });

    test("should ignore self-match against DB for already saved medicines but flag real duplicates for new additions", async () => {
      medicationRepository.findAll.mockResolvedValue([
        {
          id: "med-100",
          userId: "user-1",
          medicationName: "Paracetamol 500mg",
          softDelete: false,
        },
      ]);

      const batchInput = [
        { name: "Paracetamol 500mg", type: "TABLET", isSaved: true, dbId: "med-100" }, // Previously saved medicine (self)
        { name: "Paracetamol 500mg", type: "TABLET", isSaved: false }, // Newly added duplicate medicine
      ];

      const results = await medicationService.checkDuplicateMedicationsBatch("user-1", batchInput);

      expect(results).toHaveLength(2);
      // Previously saved medicine matching itself in DB should NOT trigger false duplicate conflict
      expect(results[0].duplicateInfo.hasDuplicate).toBe(false);
      expect(results[0].isSaved).toBe(true);

      // Newly added medicine matching existing saved medicine SHOULD trigger duplicate conflict
      expect(results[1].duplicateInfo.hasDuplicate).toBe(true);
      expect(results[1].duplicateInfo.conflictType).toBe("EXACT_DUPLICATE");
    });
  });

  describe("createMedication & updateMedication - Integrated Duplicate Checking", () => {
    const todayStr = new Date().toISOString().split("T")[0];
    const validCreatePayload = {
      medicationName: "Dolo 650",
      medicationType: "TABLET",
      dosePerIntake: 1,
      frequency: "Once Daily",
      foodFrequency: "AFTER_FOOD",
      startDate: todayStr,
      totalQuantity: 30,
      medicationSchedule: { MORNING: "09:00:00" },
    };

    test("createMedication: should create medication when no duplicate exists", async () => {
      patientRepository.findById.mockResolvedValue({ id: "user-1", patientCode: "PAT001" });
      medicationRepository.findAll.mockResolvedValue([]);
      medicationRepository.create.mockResolvedValue({ id: "med-new", ...validCreatePayload });

      const res = await medicationService.createMedication("user-1", validCreatePayload);
      expect(res.id).toBe("med-new");
      expect(medicationRepository.create).toHaveBeenCalled();
    });

    test("createMedication: should throw ConflictException when duplicate exists and no resolution provided", async () => {
      patientRepository.findById.mockResolvedValue({ id: "user-1", patientCode: "PAT001" });
      medicationRepository.findAll.mockResolvedValue([
        { id: "med-existing", medicationName: "Dolo 650", softDelete: false },
      ]);

      await expect(
        medicationService.createMedication("user-1", validCreatePayload),
      ).rejects.toThrow("A similar medication already exists.");
    });

    test("createMedication: should soft-delete existing medication and create new one when resolution is REPLACE", async () => {
      patientRepository.findById.mockResolvedValue({ id: "user-1", patientCode: "PAT001" });
      medicationRepository.findAll.mockResolvedValue([
        { id: "med-existing", userId: "user-1", medicationName: "Dolo 650", softDelete: false },
      ]);
      medicationRepository.findById.mockResolvedValue({
        id: "med-existing",
        userId: "user-1",
        medicationName: "Dolo 650",
      });
      medicationRepository.softDeleteById.mockResolvedValue(true);
      medicationRepository.create.mockResolvedValue({ id: "med-replaced", ...validCreatePayload });

      const res = await medicationService.createMedication("user-1", {
        ...validCreatePayload,
        resolution: "REPLACE",
        replaceMedicationId: "med-existing",
      });

      expect(medicationRepository.softDeleteById).toHaveBeenCalledWith("med-existing");
      expect(res.id).toBe("med-replaced");
    });

    test("createMedication: should bypass duplicate check when skipDuplicateCheck option is true", async () => {
      patientRepository.findById.mockResolvedValue({ id: "user-1", patientCode: "PAT001" });
      medicationRepository.findAll.mockResolvedValue([
        { id: "med-existing", medicationName: "Dolo 650", softDelete: false },
      ]);
      medicationRepository.create.mockResolvedValue({ id: "med-bypassed", ...validCreatePayload });

      const res = await medicationService.createMedication("user-1", validCreatePayload, {
        skipDuplicateCheck: true,
      });

      expect(res.id).toBe("med-bypassed");
    });

    test("updateMedication: should not throw conflict when updating non-name fields on existing medication (self-match)", async () => {
      const existingMed = {
        id: "med-1",
        userId: "user-1",
        medicationName: "Dolo 650",
        medicationType: "TABLET",
        totalQuantity: 30,
        dosePerIntake: 1,
      };
      medicationRepository.findById.mockResolvedValue(existingMed);
      medicationRepository.findAll.mockResolvedValue([existingMed]);
      medicationReminderRepository.findByMedicationId.mockResolvedValue(null);
      medicationRepository.updateById.mockResolvedValue({ ...existingMed, dosePerIntake: 2 });

      const res = await medicationService.updateMedication("med-1", "user-1", {
        medicationName: "Dolo 650",
        dosePerIntake: 2,
      });

      expect(res.dosePerIntake).toBe(2);
    });

    test("updateMedication: should throw ConflictException when renaming to a name that collides with another active medication", async () => {
      const currentMed = {
        id: "med-1",
        userId: "user-1",
        medicationName: "Dolo 650",
        medicationType: "TABLET",
      };
      const anotherMed = {
        id: "med-2",
        userId: "user-1",
        medicationName: "Paracetamol",
        medicationType: "TABLET",
      };
      medicationRepository.findById.mockResolvedValue(currentMed);
      medicationRepository.findAll.mockResolvedValue([currentMed, anotherMed]);

      await expect(
        medicationService.updateMedication("med-1", "user-1", {
          medicationName: "Paracetamol",
        }),
      ).rejects.toThrow("A similar medication already exists.");
    });
  });
});
