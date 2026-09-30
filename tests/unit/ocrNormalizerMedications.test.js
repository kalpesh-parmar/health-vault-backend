const { buildMedications } = require("../../src/helpers/ocrNormalizer.helper");

describe("ocrNormalizer - Medication Extraction & Normalization Unit Tests", () => {
  test("should normalize array of medication objects correctly", () => {
    const normalized = {
      medications: [
        {
          name: "Tab. Metformin 500 mg",
          dosage: "1-0-1",
          frequency: "BD",
          duration: "30 Days",
          instructions: "After meals",
        },
        {
          name: "Tab. Telmisartan 40 mg",
          dosage: "1-0-0",
          frequency: "OD",
          duration: "30 Days",
        },
      ],
    };

    const result = buildMedications(normalized);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Tab. Metformin 500 mg");
    expect(result[0].dosage).toBe("1-0-1");
    expect(result[1].name).toBe("Tab. Telmisartan 40 mg");
  });

  test("should handle string array returned by AI structuring models without losing items", () => {
    const normalized = {
      medications: [
        "1. Tab. Metformin 500 mg BD - After Meals",
        "2. Tab. Telmisartan 40 mg OD - After Breakfast",
        "3. Tab. Atorvastatin 10 mg HS",
      ],
    };

    const result = buildMedications(normalized);
    expect(result).toHaveLength(3);
    expect(result[0].name).toBe("1. Tab. Metformin 500 mg BD - After Meals");
    expect(result[1].name).toBe("2. Tab. Telmisartan 40 mg OD - After Breakfast");
    expect(result[2].name).toBe("3. Tab. Atorvastatin 10 mg HS");
  });

  test("should extract medications from nested prescriptions array", () => {
    const normalized = {
      doctorInfo: { name: "Ananya Sharma" },
      prescriptions: [
        {
          doctorName: "Dr. Ananya Sharma",
          medications: [{ name: "Tab. Ecosprin 75 mg", dosage: "1-0-0" }, "Tab. Vitamin D3 60K"],
        },
      ],
    };

    const result = buildMedications(normalized);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe("Tab. Ecosprin 75 mg");
    expect(result[0].prescribedBy).toBe("Dr. Ananya Sharma");
    expect(result[1].name).toBe("Tab. Vitamin D3 60K");
  });

  test("should filter out items with null or non-string names", () => {
    const normalized = {
      medications: [null, undefined, { dosage: "1-0-1" }, { name: "Tab. Dolo 650" }],
    };

    const result = buildMedications(normalized);
    expect(result).toHaveLength(1);
    expect(result[0].name).toBe("Tab. Dolo 650");
  });
});
