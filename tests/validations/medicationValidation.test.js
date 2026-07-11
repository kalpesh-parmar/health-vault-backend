const { medicationOnboardingSchema } = require("../../src/validations/medicationValidation");
const medicationService = require("../../src/services/medicationService");

describe("Medication Validation, Defaults & Round-trip", () => {
  describe("Zod Validation Schema (medicationOnboardingSchema)", () => {
    it("should accept valid tablet dose payload", () => {
      const payload = {
        name: "Aspirin",
        type: "TABLET",
        frequency: "ONCE",
        dose: { count: 1 },
        client_med_id: "client-id-1",
        source: "MANUAL",
      };
      const res = medicationOnboardingSchema.safeParse(payload);
      expect(res.success).toBe(true);
    });

    it("should accept valid fractional tablet count (0.25 increments)", () => {
      const payload = {
        name: "Aspirin",
        type: "TABLET",
        frequency: "ONCE",
        dose: { count: 0.75 },
        client_med_id: "client-id-2",
      };
      const res = medicationOnboardingSchema.safeParse(payload);
      expect(res.success).toBe(true);
    });

    it("should reject non-fractional increments (e.g. 0.3)", () => {
      const payload = {
        name: "Aspirin",
        type: "TABLET",
        frequency: "ONCE",
        dose: { count: 0.3 },
        client_med_id: "client-id-3",
      };
      const res = medicationOnboardingSchema.safeParse(payload);
      expect(res.success).toBe(false);
      expect(res.error.errors[0].message).toBe("Count must be in increments of 0.25");
    });

    it("should reject wrong unit for type (e.g. ml for TABLET)", () => {
      const payloadBad = {
        name: "Aspirin",
        type: "TABLET",
        frequency: "ONCE",
        dose: { value: 5, unit: "ml" },
        client_med_id: "client-id-5",
      };
      const res = medicationOnboardingSchema.safeParse(payloadBad);
      expect(res.success).toBe(false);
    });

    it("should accept valid liquid/other doses with allowed units", () => {
      const payload = {
        name: "Cough Syrup",
        type: "SYRUP",
        frequency: "TWICE",
        dose: { value: 10, unit: "ml" },
        client_med_id: "client-id-6",
      };
      const res = medicationOnboardingSchema.safeParse(payload);
      expect(res.success).toBe(true);
    });

    it("should reject invalid unit for SYRUP (e.g. drops)", () => {
      const payload = {
        name: "Cough Syrup",
        type: "SYRUP",
        frequency: "TWICE",
        dose: { value: 10, unit: "drops" },
        client_med_id: "client-id-7",
      };
      const res = medicationOnboardingSchema.safeParse(payload);
      expect(res.success).toBe(false);
      expect(res.error.errors[0].message).toContain("Unit must be one of: ml, tsp, tbsp");
    });
  });

  describe("applyDefaults", () => {
    it("should apply correct defaults for ONCE daily", () => {
      const res = medicationService.applyDefaults("ONCE");
      expect(res.best_times).toEqual(["08:00"]);
      expect(res.reminder_times).toEqual(["08:00"]);
      expect(res.food_context).toBe("AFTER_FOOD");
    });

    it("should apply correct defaults for TWICE daily", () => {
      const res = medicationService.applyDefaults("TWICE");
      expect(res.best_times).toEqual(["08:00", "20:00"]);
      expect(res.reminder_times).toEqual(["08:00", "20:00"]);
    });

    it("should apply correct defaults for THRICE daily", () => {
      const res = medicationService.applyDefaults("THRICE");
      expect(res.best_times).toEqual(["08:00", "14:00", "20:00"]);
      expect(res.reminder_times).toEqual(["08:00", "14:00", "20:00"]);
    });
  });

  describe("Round-trip fraction and NOT NULL population mapping", () => {
    const mockPatient = {
      id: "patient-123",
      patientCode: "P-999",
    };

    beforeEach(() => {
      const patientRepository = require("../../src/repositories/patientRepository");
      const medicationRepository = require("../../src/repositories/medicationRepository");
      jest.spyOn(patientRepository, "findById").mockResolvedValue(mockPatient);
      jest
        .spyOn(medicationRepository, "insert")
        .mockImplementation((data) => Promise.resolve({ id: "med-123", ...data }));
    });

    afterEach(() => {
      jest.restoreAllMocks();
    });

    it("should round-trip fraction (0.5 tablet) correctly and populate all required fields", async () => {
      const payload = {
        name: "Aspirin",
        type: "TABLET",
        frequency: "ONCE",
        dose: { count: 0.5 },
        client_med_id: "client-id-0.5",
        source: "OCR",
        refill_alert: true,
        total_quantity: 30,
      };

      const result = await medicationService.create("patient-123", payload);

      // Verify that all NOT NULL database columns are populated
      expect(result.userId).toBe("patient-123");
      expect(result.patientCode).toBe("P-999");
      expect(result.medicationName).toBe("Aspirin");
      expect(result.medicationType).toBe("TABLET");
      expect(result.frequency).toBe("Once Daily");
      expect(result.foodFrequency).toBe("AFTER_FOOD");
      expect(result.startDate).toBeInstanceOf(Date);
      expect(result.ongoing).toBe(true);
      expect(result.unit).toBe("TABLET");
      expect(result.dailyConsumption).toBe(1); // Math.ceil(0.5) * 1 = 1
      expect(result.totalQuantity).toBe(30);

      // Verify dosePerIntake column mapping: fraction -> null
      expect(result.dosePerIntake).toBeNull();

      // Verify medicationSchedule JSON round-trip value
      expect(result.medicationSchedule.dose.value).toBe(0.5);
      expect(result.medicationSchedule.dose.unit).toBe("tablet");
      expect(result.medicationSchedule.source).toBe("OCR");
      expect(result.medicationSchedule.refillAlert).toBe(true);
    });

    it("should populate dosePerIntake as integer when whole", async () => {
      const payload = {
        name: "Paracetamol",
        type: "TABLET",
        frequency: "TWICE",
        dose: { count: 2 },
        client_med_id: "client-id-whole",
      };

      const result = await medicationService.create("patient-123", payload);
      expect(result.dosePerIntake).toBe(2);
      expect(result.dailyConsumption).toBe(4); // Math.ceil(2) * 2 = 4
      expect(result.medicationSchedule.dose.value).toBe(2);
    });
  });
});
