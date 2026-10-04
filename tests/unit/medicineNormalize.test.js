const { normalizeMedicine } = require("../../src/helpers/medicineNormalize.helper");
const medicationMapper = require("../../src/helpers/medicationMapper.helper");

describe("medicineNormalize.helper - Provenance & Fallback Verification Flagging", () => {
  const defaults = {
    userId: "user-123",
    patientCode: "P-100",
    startDate: "2026-10-04",
    prescribedBy: "Dr. Sharma",
  };

  test("normalizes primary OCR medication with default provenance and false verification", () => {
    const rawMed = {
      name: "Tab Paracetamol 500mg",
      dosage: "500mg",
      frequency: "1-0-1",
      timing: "After meals",
    };

    const { row, onboardingMed } = normalizeMedicine(rawMed, 0, defaults.patientCode, defaults);

    expect(row.medicationName).toBe("Paracetamol 500mg");
    expect(row.medicationSchedule.provenance).toBe("primary_ocr");
    expect(row.medicationSchedule.verificationRequired).toBe(false);

    expect(onboardingMed.provenance).toBe("primary_ocr");
    expect(onboardingMed.verificationRequired).toBe(false);
    expect(onboardingMed.needsReview.fallbackVerification).toBeUndefined();
    expect(onboardingMed.source).toBe("OCR");
  });

  test("normalizes VLM fallback medication with vlm_fallback provenance and true verification", () => {
    const rawMed = {
      name: "Tab Azithromycin 500mg",
      dosage: "500mg",
      frequency: "OD",
      timing: "After food",
      provenance: "vlm_fallback",
      verification_required: true,
      confidence: 0.88,
    };

    const { row, onboardingMed } = normalizeMedicine(rawMed, 1, defaults.patientCode, defaults);

    expect(row.medicationSchedule.provenance).toBe("vlm_fallback");
    expect(row.medicationSchedule.verificationRequired).toBe(true);
    expect(row.medicationSchedule.confidence).toBe(0.88);
    expect(row.medicationSchedule.source).toBe("VLM_FALLBACK");

    expect(onboardingMed.provenance).toBe("vlm_fallback");
    expect(onboardingMed.verificationRequired).toBe(true);
    expect(onboardingMed.confidence).toBe(0.88);
    expect(onboardingMed.needsReview.fallbackVerification).toBe(true);
    expect(onboardingMed.source).toBe("VLM_FALLBACK");
  });

  test("normalizes legacy VLM_FALLBACK source format", () => {
    const rawMed = {
      name: "Augmentin 625mg",
      dosage: "625mg",
      frequency: "BID",
      source: "VLM_FALLBACK",
    };

    const { row, onboardingMed } = normalizeMedicine(rawMed, 2, defaults.patientCode, defaults);

    expect(row.medicationSchedule.provenance).toBe("vlm_fallback");
    expect(row.medicationSchedule.verificationRequired).toBe(true);
    expect(onboardingMed.needsReview.fallbackVerification).toBe(true);
    expect(onboardingMed.source).toBe("VLM_FALLBACK");
  });

  test("medicationMapper.buildRows preserves provenance and verification in schedule", () => {
    const medications = [
      {
        name: "Amoxicillin 500mg",
        provenance: "vlm_fallback",
        verificationRequired: true,
      },
      {
        name: "Cetirizine 10mg",
        provenance: "primary_ocr",
      },
    ];

    const { rows, skipped } = medicationMapper.buildRows({
      userId: defaults.userId,
      patientCode: defaults.patientCode,
      medications,
      defaults,
    });

    expect(skipped).toHaveLength(0);
    expect(rows).toHaveLength(2);

    expect(rows[0].medicationSchedule.provenance).toBe("vlm_fallback");
    expect(rows[0].medicationSchedule.verificationRequired).toBe(true);

    expect(rows[1].medicationSchedule.provenance).toBe("primary_ocr");
    expect(rows[1].medicationSchedule.verificationRequired).toBe(false);
  });
});
