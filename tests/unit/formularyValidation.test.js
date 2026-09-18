const {
  validateMedication,
  levenshteinDistance,
  extractForm,
  extractCoreToken,
} = require("../../src/helpers/formulary.helper");
const { buildMedications } = require("../../src/helpers/ocrNormalizer.helper");
const { MedicalExtractionSchema } = require("../../src/validations/ocr.validation");

describe("Phase 6: Canonical Medical Extraction & Medicine Validation Unit Tests", () => {
  describe("1. Exact Formulary Brand & Generic Matching (REQ-03)", () => {
    test("Identifies standard antipyretic brands (Dolo 650, Crocin) and resolves to Paracetamol", () => {
      const medDolo = { name: "Tab. Dolo 650", dosage: "1-0-1" };
      const resDolo = validateMedication(medDolo);
      expect(resDolo.isFormularyMatch).toBe(true);
      expect(resDolo.genericName).toBe("Paracetamol");
      expect(resDolo.confidence).toBeGreaterThanOrEqual(0.95);
      expect(resDolo.flaggedForReview).toBe(false);

      const medCrocin = { name: "Crocin 500mg", dosage: "1-1-1" };
      const resCrocin = validateMedication(medCrocin);
      expect(resCrocin.isFormularyMatch).toBe(true);
      expect(resCrocin.genericName).toBe("Paracetamol");
      expect(resCrocin.confidence).toBeGreaterThanOrEqual(0.95);
    });

    test("Identifies antidiabetic medications (Metformin, Glycomet)", () => {
      const med = { name: "Tab. Glycomet 500mg SR", dosage: "1-0-1", type: "Tablet" };
      const res = validateMedication(med);
      expect(res.isFormularyMatch).toBe(true);
      expect(res.genericName).toBe("Metformin Hydrochloride");
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
      expect(res.type).toBe("Tablet");
    });

    test("Identifies gastrointestinal PPIs (Pan 40, Pantocid)", () => {
      const med = { name: "Pan 40", dosage: "1-0-0" };
      const res = validateMedication(med);
      expect(res.isFormularyMatch).toBe(true);
      expect(res.genericName).toBe("Pantoprazole");
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
    });

    test("Identifies broad-spectrum antibiotics (Augmentin 625, Moxclav)", () => {
      const med = { name: "Tab. Augmentin 625mg", dosage: "1-0-1", duration: "5 Days" };
      const res = validateMedication(med);
      expect(res.isFormularyMatch).toBe(true);
      expect(res.genericName).toBe("Amoxicillin and Potassium Clavulanate");
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
      expect(res.flaggedForReview).toBe(false);
    });

    test("Identifies cardiovascular agents (Telma 40, Amlong 5)", () => {
      const medTelma = { name: "Telma 40mg", dosage: "1-0-0" };
      const resTelma = validateMedication(medTelma);
      expect(resTelma.isFormularyMatch).toBe(true);
      expect(resTelma.genericName).toBe("Telmisartan");
      expect(resTelma.confidence).toBeGreaterThanOrEqual(0.95);

      const medAmlong = { name: "Tab. Amlong 5mg", dosage: "0-0-1" };
      const resAmlong = validateMedication(medAmlong);
      expect(resAmlong.isFormularyMatch).toBe(true);
      expect(resAmlong.genericName).toBe("Amlodipine");
    });

    test("Identifies respiratory and allergy combinations (Montek LC)", () => {
      const med = { name: "Montek LC", dosage: "0-0-1" };
      const res = validateMedication(med);
      expect(res.isFormularyMatch).toBe(true);
      expect(res.genericName).toBe("Montelukast and Levocetirizine");
      expect(res.confidence).toBeGreaterThanOrEqual(0.95);
    });

    test("Identifies calcium and vitamin D3 supplements (Shelcal, Caldison)", () => {
      const med = { name: "Tab. Shelcal 500", dosage: "1-0-0" };
      const res = validateMedication(med);
      expect(res.isFormularyMatch).toBe(true);
      expect(res.genericName).toBe("Calcium and Vitamin D3");
    });
  });

  describe("2. Fuzzy OCR Typo Correction & Distance Matching", () => {
    test("Corrects minor optical character errors in brand names (Doiо -> Dolo)", () => {
      // Cyrillic/glyph confusion or 'i' substitution
      const dist = levenshteinDistance("doio", "dolo");
      expect(dist).toBeLessThanOrEqual(2);

      const med = { name: "Tab. Doio 650", dosage: "1-0-1" };
      const res = validateMedication(med);
      expect(res.isFormularyMatch).toBe(true);
      expect(res.genericName).toBe("Paracetamol");
      expect(res.confidence).toBeGreaterThanOrEqual(0.85);
      expect(res.flaggedForReview).toBe(false);
    });

    test("Corrects minor OCR errors in Telma (Teima -> Telma)", () => {
      const med = { name: "Tab. Teima 40mg", dosage: "1-0-0" };
      const res = validateMedication(med);
      expect(res.isFormularyMatch).toBe(true);
      expect(res.genericName).toBe("Telmisartan");
      expect(res.confidence).toBeGreaterThanOrEqual(0.85);
      expect(res.flaggedForReview).toBe(false);
    });
  });

  describe("3. Confidence Scoring & Review Flagging", () => {
    test("Assigns medium confidence to unlisted drug with valid dosage structure", () => {
      const med = {
        name: "Tab. NovelCardio 25mg",
        dosage: "1-0-1",
        instructions: "After breakfast",
      };
      const res = validateMedication(med);
      expect(res.isFormularyMatch).toBe(false);
      expect(res.confidence).toBeGreaterThanOrEqual(0.7);
      expect(res.confidence).toBeLessThan(0.85);
      expect(res.flaggedForReview).toBe(false);
    });

    test("Flags unrecognized or garbled OCR text for clinical review", () => {
      const medGarbled = { name: "Xqzz#12!", dosage: null };
      const resGarbled = validateMedication(medGarbled);
      expect(resGarbled.isFormularyMatch).toBe(false);
      expect(resGarbled.confidence).toBeLessThanOrEqual(0.6);
      expect(resGarbled.flaggedForReview).toBe(true);
    });

    test("Handles empty or null medication names safely", () => {
      const resNull = validateMedication(null);
      expect(resNull.name).toBeNull();
      expect(resNull.confidence).toBe(0.0);
      expect(resNull.flaggedForReview).toBe(true);
    });
  });

  describe("4. Dosage Form Extraction & Core Token Parsing", () => {
    test("extractForm detects Tablet, Capsule, Syrup, and Injection accurately", () => {
      expect(extractForm("Tab. Metformin 500mg")).toBe("Tablet");
      expect(extractForm("Cap. Amoxicillin 250mg")).toBe("Capsule");
      expect(extractForm("Syp. Paracetamol 120mg")).toBe("Syrup");
      expect(extractForm("Inj. Pantoprazole 40mg")).toBe("Injection");
      expect(extractForm("Cifran Eye Drops")).toBe("Drops");
      expect(extractForm("Unknown Drug", "Tablet")).toBe("Tablet");
    });

    test("extractCoreToken strips strength, dosage form, and trailing notation", () => {
      expect(extractCoreToken("Tab. Dolo 650mg")).toBe("dolo");
      expect(extractCoreToken("Cap. Amoxicillin 500 mg")).toBe("amoxicillin");
      expect(extractCoreToken("Tab. Glycomet SR 500mg")).toBe("glycomet");
      expect(extractCoreToken("Pan 40")).toBe("pan");
      expect(extractCoreToken("Montek-LC")).toBe("montek");
    });
  });

  describe("5. Integration with buildMedications & MedicalExtractionSchema", () => {
    test("buildMedications enriches all medications with formulary metrics", () => {
      const rawNormalized = {
        medications: [
          {
            name: "Tab. Dolo 650",
            dosage: "1-0-1",
            duration: "3 Days",
            quantity: "10",
            instructions: "After meals",
          },
          {
            name: "Tab. Pan 40",
            dosage: "1-0-0",
            duration: "10 Days",
            quantity: "10",
            instructions: "10", // purely a quantity -> should be sanitized to null!
          },
        ],
      };

      const meds = buildMedications(rawNormalized);
      expect(meds).toHaveLength(2);

      // First medication
      expect(meds[0].name).toBe("Tab. Dolo 650");
      expect(meds[0].genericName).toBe("Paracetamol");
      expect(meds[0].isFormularyMatch).toBe(true);
      expect(meds[0].confidence).toBeGreaterThanOrEqual(0.95);
      expect(meds[0].instructions).toBe("After meals");

      // Second medication - instruction sanitized
      expect(meds[1].name).toBe("Tab. Pan 40");
      expect(meds[1].genericName).toBe("Pantoprazole");
      expect(meds[1].instructions).toBeNull(); // sanitized
    });

    test("Enriched medications conform strictly to MedicalExtractionSchema", () => {
      const rawNormalized = {
        patientInfo: { name: "Rajesh Patel" },
        medications: [
          {
            name: "Tab. Augmentin 625mg",
            dosage: "1-0-1",
            duration: "5 Days",
            quantity: "10",
            instructions: "After food",
          },
        ],
      };

      const meds = buildMedications(rawNormalized);
      const testExtraction = {
        patientName: "Rajesh Patel",
        medications: meds,
        testResults: [],
      };

      const zodResult = MedicalExtractionSchema.passthrough().safeParse(testExtraction);
      expect(zodResult.success).toBe(true);
    });
  });
});
