const { normalizeCreateMedicationInput } = require("../../src/helpers/medicineNormalize.helper");

describe("normalizeCreateMedicationInput Dual-Compatibility Tests", () => {
  test("should correctly process standard UnifiedMedicationInput (camelCase)", () => {
    const input = {
      medicationName: "Metformin 1000mg",
      medicationType: "TABLET",
      prescribedBy: "Dr. Smith",
      dosePerIntake: 1,
      frequency: "Once Daily",
      foodFrequency: "AFTER_FOOD",
      startDate: "2026-09-22",
      totalQuantity: 60,
      reminderBeforeMinutes: 5,
      notes: "Take with water",
      medicationSchedule: { Morning: "09:00:00" },
    };

    const normalized = normalizeCreateMedicationInput(input);

    expect(normalized.medicationName).toBe("Metformin 1000mg");
    expect(normalized.medicationType).toBe("TABLET");
    expect(normalized.prescribedBy).toBe("Dr. Smith");
    expect(normalized.dosePerIntake).toBe(1);
    expect(normalized.frequency).toBe("Once Daily");
    expect(normalized.foodFrequency).toBe("AFTER_FOOD");
    expect(normalized.startDate).toBe("2026-09-22");
    expect(normalized.totalQuantity).toBe(60);
    expect(normalized.reminderBeforeMinutes).toBe(5);
    expect(normalized.notes).toBe("Take with water");
    expect(normalized.medicationSchedule).toEqual({ Morning: "09:00:00" });
  });

  test("should correctly normalize legacy shorthand & snake_case payload (name, type, dose object, prescribed_by, refill_alert)", () => {
    const legacyInput = {
      name: "Amoxicillin 500mg",
      type: "CAPSULE",
      dose: { count: 2 },
      frequency: "ONCE",
      food_context: "BEFORE_FOOD",
      prescribed_by: "Dr. Adams",
      refill_alert: true,
      total_quantity: 30,
      notes: "After breakfast",
    };

    const normalized = normalizeCreateMedicationInput(legacyInput);

    expect(normalized.medicationName).toBe("Amoxicillin 500mg");
    expect(normalized.medicationType).toBe("CAPSULE");
    expect(normalized.dosePerIntake).toBe(2);
    expect(normalized.frequency).toBe("Once Daily");
    expect(normalized.foodFrequency).toBe("BEFORE_FOOD");
    expect(normalized.prescribedBy).toBe("Dr. Adams");
    expect(normalized.refillAlert).toBe(true);
    expect(normalized.totalQuantity).toBe(30);
    expect(normalized.notes).toBe("After breakfast");
    expect(normalized.medicationSchedule).toEqual({ Morning: "09:00:00" });
  });

  test("should fallback gracefully for missing fields and derive frequency schedule", () => {
    const minimalInput = {
      name: "Paracetamol 650mg",
      frequency: "TWICE",
    };

    const normalized = normalizeCreateMedicationInput(minimalInput);

    expect(normalized.medicationName).toBe("Paracetamol 650mg");
    expect(normalized.medicationType).toBe("TABLET");
    expect(normalized.dosePerIntake).toBe(1);
    expect(normalized.frequency).toBe("Twice Daily");
    expect(normalized.medicationSchedule).toEqual({
      Morning: "09:00:00",
      Night: "21:00:00",
    });
    expect(normalized.foodFrequency).toBe("AFTER_FOOD");
    expect(normalized.totalQuantity).toBe(30);
    expect(normalized.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});
