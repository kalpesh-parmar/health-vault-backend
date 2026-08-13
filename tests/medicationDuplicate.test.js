const medicationService = require("../src/services/medication.service");
const patientRepository = require("../src/repositories/patientRepository");
const medicationRepository = require("../src/repositories/medicationRepository");

jest.mock("../src/repositories/patientRepository");
jest.mock("../src/repositories/medicationRepository");

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
});
