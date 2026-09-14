const { ocrService } = require("../../src/services/ai/ocr/ocr.service");
const aiClient = require("../../src/services/ai/clients/aiClient.service");
const aiServiceClient = require("../../src/clients/aiServiceClient");
const { ollamaClient } = require("../../src/clients/ollamaClient");
const { normalizeLanguage } = require("../../src/utils/commonUtils");
const {
  extractKeyPoints,
  synthesizeClinicalSummary,
  buildSummaryPrompt,
} = require("../../src/helpers/summary.helper");
const { MedicalExtractionSchema } = require("../../src/validations/ocr.validation");

describe("Multilingual Summary Unit Tests", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("Language Normalization", () => {
    it("should normalize Gujarati language aliases correctly", () => {
      expect(normalizeLanguage("gu")).toBe("gujarati");
      expect(normalizeLanguage("gujarati")).toBe("gujarati");
      expect(normalizeLanguage("GUJARATI")).toBe("gujarati");
      expect(normalizeLanguage("GU")).toBe("gujarati");
    });

    it("should normalize Hindi language aliases correctly", () => {
      expect(normalizeLanguage("hi")).toBe("hindi");
      expect(normalizeLanguage("hindi")).toBe("hindi");
      expect(normalizeLanguage("HIN")).toBe("hindi");
    });

    it("should normalize Marathi language aliases correctly", () => {
      expect(normalizeLanguage("mr")).toBe("marathi");
      expect(normalizeLanguage("marathi")).toBe("marathi");
      expect(normalizeLanguage("MAR")).toBe("marathi");
    });

    it("should normalize Tamil language aliases correctly", () => {
      expect(normalizeLanguage("ta")).toBe("tamil");
      expect(normalizeLanguage("tamil")).toBe("tamil");
      expect(normalizeLanguage("TAM")).toBe("tamil");
    });

    it("should fallback to english for unsupported or empty language", () => {
      expect(normalizeLanguage("")).toBe("english");
      expect(normalizeLanguage(null)).toBe("english");
      expect(normalizeLanguage(undefined)).toBe("english");
      expect(normalizeLanguage("unsupported_lang")).toBe("english");
    });
  });

  describe("ocrService.generateSummary with Multilingual Support", () => {
    it("should generate a Gujarati summary while preserving medical entities", async () => {
      const mockSummaryText =
        "ડૉ. Patel દ્વારા Apex Hospital ખાતે લખાયેલ પ્રિસ્ક્રિપ્શન. Metformin 500mg દિવસમાં બે વાર ભોજન પછી લેવી.";
      jest.spyOn(ollamaClient, "generate").mockResolvedValue(mockSummaryText);

      const rawText =
        "Dr. Patel at Apex Hospital prescribed Metformin 500mg twice daily after meals.";
      const summary = await ocrService.generateSummary(rawText, "gujarati");

      expect(summary).toBe(mockSummaryText);
      expect(ollamaClient.generate).toHaveBeenCalledTimes(1);
      const prompt = ollamaClient.generate.mock.calls[0][0];
      expect(prompt).toContain("Gujarati");
      expect(prompt).toContain("doctor names");
      expect(prompt).toContain("drug/medication names");
    });

    it("should fallback to English prompt when preferredLanguage is english", async () => {
      const mockSummaryText = "Dr. Patel at Apex Hospital prescribed Metformin 500mg.";
      jest.spyOn(ollamaClient, "generate").mockResolvedValue(mockSummaryText);

      const rawText = "Dr. Patel at Apex Hospital prescribed Metformin 500mg.";
      const summary = await ocrService.generateSummary(rawText, "english");

      expect(summary).toBe(mockSummaryText);
      const prompt = ollamaClient.generate.mock.calls[0][0];
      expect(prompt).toContain("English");
      expect(prompt).toContain("doctor names");
    });
  });

  describe("ocrService.translateSummary", () => {
    it("should translate an English summary to Gujarati via aiClient.translate", async () => {
      const engText = "Blood test report showing normal HbA1c levels.";
      const gujText = "સામાન્ય HbA1c સ્તર દર્શાવતો બ્લડ ટેસ્ટ રિપોર્ટ.";

      jest.spyOn(aiClient, "translate").mockResolvedValue(gujText);

      const result = await ocrService.translateSummary(engText, "gujarati", "english");
      expect(result).toBe(gujText);
      expect(aiClient.translate).toHaveBeenCalledWith(engText, "english", "gujarati");
    });

    it("should return original text if targetLanguage is english", async () => {
      const engText = "Blood test report showing normal HbA1c levels.";
      const spy = jest.spyOn(aiClient, "translate");

      const result = await ocrService.translateSummary(engText, "english", "english");
      expect(result).toBe(engText);
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe("aiClient LLM translation fallback with medical preservation", () => {
    it("should use LLM translation when IndicTrans2 returns untranslated echo", async () => {
      const sourceText = "Dr. Mehta prescribed Paracetamol 650mg for fever.";
      const translatedText = "તાવ માટે ડૉ. Mehta દ્વારા Paracetamol 650mg સૂચવવામાં આવી છે.";

      jest.spyOn(aiServiceClient, "translate").mockResolvedValue({
        translated_text: sourceText,
      });

      jest.spyOn(ollamaClient, "generate").mockResolvedValue(translatedText);

      const result = await aiClient.translate(sourceText, "english", "gujarati");
      expect(result).toBe(translatedText);
      expect(ollamaClient.generate).toHaveBeenCalledTimes(1);

      const llmPrompt = ollamaClient.generate.mock.calls[0][0];
      expect(llmPrompt).toContain(
        "Translate the following medical report/prescription summary into natural, fluent Gujarati",
      );
      expect(llmPrompt).toContain("Doctor names");
      expect(llmPrompt).toContain("Medicine / drug names");
    });
  });

  describe("Phase 7 REQ-04: Four-Scenario Operational Test Matrix", () => {
    const sampleRawText =
      "Patient: Ramesh Shah, Age: 52. Diagnosis: Type 2 Diabetes Mellitus, Essential Hypertension.\n" +
      "Rx: Tab. Telma 40mg 1-0-0 before breakfast, Tab. Metformin 500mg 1-0-1 after food.\n" +
      "HbA1c: 8.4% (High), Fasting Blood Sugar: 168 mg/dL (High).";

    it("Scenario 1 (Native Indic): Generates native Gujarati clinical summary and sets summaryLanguage to gujarati", async () => {
      const gujSummary =
        "ડૉ. દ્વારા લખાયેલ પ્રિસ્ક્રિપ્શન. દર્દી રમેશ શાહ માટે Type 2 Diabetes Mellitus અને Hypertension નું નિદાન થયેલ છે. " +
        "દવાઓમાં Tab. Telma 40mg અને Tab. Metformin 500mg સૂચવેલ છે.";
      const engSummary =
        "Prescription for Ramesh Shah. Diagnosed with Type 2 Diabetes Mellitus and Essential Hypertension. " +
        "Prescribed Tab. Telma 40mg and Tab. Metformin 500mg.";

      jest.spyOn(ollamaClient, "generate").mockImplementation((prompt) => {
        if (prompt.includes("Gujarati")) return Promise.resolve(gujSummary);
        return Promise.resolve(engSummary);
      });

      const result = await synthesizeClinicalSummary({
        rawText: sampleRawText,
        structuredData: {
          diagnosis: ["Type 2 Diabetes Mellitus", "Essential Hypertension"],
          medications: [
            { canonicalName: "Telmisartan", name: "Tab. Telma 40mg", dosage: "1-0-0" },
            { canonicalName: "Metformin", name: "Tab. Metformin 500mg", dosage: "1-0-1" },
          ],
        },
        preferredLanguage: "gujarati",
        detectedLanguages: ["gujarati", "english"],
        ollamaClient,
        aiClient,
      });

      expect(result.summaryLanguage).toBe("gujarati");
      expect(result.summaryInPreferredLanguage).toBe(gujSummary);
      expect(result.summaryEnglish).toBe(engSummary);
      expect(result.summary).toBe(gujSummary);
      expect(result.keyPoints.length).toBeGreaterThan(0);
    });

    it("Scenario 2 (Cross-Lingual): English/Hindi doc to Tamil/Hindi summary with correct summaryLanguage", async () => {
      const engSummary =
        "Patient Ramesh Shah diagnosed with Type 2 Diabetes Mellitus. Prescribed Metformin 500mg.";
      const tamSummary =
        "நோயாளி Ramesh Shah-க்கு Type 2 Diabetes Mellitus கண்டறியப்பட்டது. Metformin 500mg பரிந்துரைக்கப்பட்டது.";

      jest.spyOn(ollamaClient, "generate").mockImplementation((prompt) => {
        if (prompt.includes("Tamil")) return Promise.resolve(tamSummary);
        return Promise.resolve(engSummary);
      });

      const result = await synthesizeClinicalSummary({
        rawText: sampleRawText,
        structuredData: {
          diagnosis: ["Type 2 Diabetes Mellitus"],
          medications: [{ canonicalName: "Metformin", name: "Metformin 500mg", dosage: "1-0-1" }],
        },
        preferredLanguage: "tamil",
        detectedLanguages: ["english"],
        ollamaClient,
        aiClient,
      });

      expect(result.summaryLanguage).toBe("tamil");
      expect(result.summaryInPreferredLanguage).toBe(tamSummary);
      expect(result.summary).toBe(tamSummary);
    });

    it("Scenario 3 (Mixed-Language): Prompt preserves English medication brand names and Latin dosages in Indic text", () => {
      const prompt = buildSummaryPrompt(sampleRawText, "hindi");
      expect(prompt).toContain("Hindi");
      expect(prompt).toContain("Metformin 500mg");
      expect(prompt).toContain("in English characters");
      expect(prompt).toContain("confusing for patients");
    });

    it("Scenario 4 (Absent/Fallback): Falls back to English summary when preferredLanguage is null or unsupported", async () => {
      const engSummary = "Prescription summary in standard English.";
      jest.spyOn(ollamaClient, "generate").mockResolvedValue(engSummary);

      const result = await synthesizeClinicalSummary({
        rawText: sampleRawText,
        structuredData: {},
        preferredLanguage: "klingon_unsupported",
        detectedLanguages: ["unknown"],
        ollamaClient,
        aiClient,
      });

      expect(result.summaryLanguage).toBe("english");
      expect(result.summaryEnglish).toBe(engSummary);
      expect(result.summaryInPreferredLanguage).toBe(engSummary);
      expect(result.summary).toBe(engSummary);
    });
  });

  describe("Phase 7 REQ-04: Key Clinical Points Extraction & Deduplication", () => {
    it("extracts and deduplicates diagnoses repeated across multiple pages or sections", () => {
      const structuredData = {
        diagnosis: [
          "Type 2 Diabetes Mellitus",
          "Essential Hypertension",
          "Type 2 Diabetes", // Redundant substring
          "Hypertension", // Redundant substring
          "Type 2 Diabetes Mellitus", // Exact duplicate
        ],
        testResults: [
          { name: "HbA1c", value: "8.5", unit: "%", status: "HIGH", isAbnormal: true },
          {
            name: "Total Cholesterol",
            value: "240",
            unit: "mg/dL",
            status: "HIGH",
            isAbnormal: true,
          },
          {
            name: "Serum Creatinine",
            value: "0.9",
            unit: "mg/dL",
            status: "NORMAL",
            isAbnormal: false,
          },
        ],
        medications: [
          { canonicalName: "Metformin", name: "Metformin 500mg", dosage: "1-0-1", frequency: "BD" },
          { canonicalName: "Telmisartan", name: "Telma 40", dosage: "1-0-0", frequency: "OD" },
          { canonicalName: "Metformin", name: "Metformin 500mg", dosage: "1-0-1" }, // Duplicate medication
        ],
      };

      const keyPoints = extractKeyPoints(structuredData, "Clinical summary text");

      // Verify each item is highlighted exactly once
      const diagDiabetes = keyPoints.filter((k) => k.toLowerCase().includes("diabetes"));
      expect(diagDiabetes.length).toBe(1);

      const diagHyper = keyPoints.filter((k) => k.toLowerCase().includes("hypertension"));
      expect(diagHyper.length).toBe(1);

      // Verify abnormal lab results are included, while normal lab results are excluded
      expect(keyPoints.some((k) => k.includes("HbA1c: 8.5 % (HIGH)"))).toBe(true);
      expect(keyPoints.some((k) => k.includes("Total Cholesterol"))).toBe(true);
      expect(keyPoints.some((k) => k.includes("Serum Creatinine"))).toBe(false);

      // Verify duplicate medication is highlighted once
      const medMetformin = keyPoints.filter((k) => k.toLowerCase().includes("metformin"));
      expect(medMetformin.length).toBe(1);
    });

    it("filters out boilerplate and non-informative phrases from summary fallback", () => {
      const structuredData = {};
      const summaryText =
        "This is a summary of the report.\n" +
        "Blood pressure is within normal limits.\n" +
        "Patient exhibits severe persistent migraine with aura.\n" +
        "Doctor advises immediate brain MRI scan.";

      const keyPoints = extractKeyPoints(structuredData, summaryText);

      expect(keyPoints.some((k) => k.toLowerCase().includes("migraine"))).toBe(true);
      expect(keyPoints.some((k) => k.toLowerCase().includes("brain mri"))).toBe(true);
      expect(keyPoints.some((k) => k.toLowerCase().includes("within normal limits"))).toBe(false);
      expect(keyPoints.some((k) => k.toLowerCase().startsWith("this is a summary"))).toBe(false);
    });
  });

  describe("Phase 7: Schema & Payload Conformance", () => {
    it("conforms strictly to MedicalExtractionSchema with keyPoints, summaryLanguage, and detectedLanguages", () => {
      const payload = {
        patientName: "Ramesh Shah",
        firstName: "Ramesh",
        lastName: "Shah",
        age: 52,
        gender: "male",
        reportDate: "2026-09-14",
        visitDate: "2026-09-14",
        doctorName: "Dr. Bakul Patel",
        hospitalName: "Uma Clinic",
        diagnosis: ["Type 2 Diabetes Mellitus"],
        medications: [
          {
            name: "Tab. Telma 40",
            dosage: "1-0-0",
            frequency: "OD",
            canonicalName: "Telmisartan",
            isFormularyMatch: true,
            confidence: 0.95,
            flaggedForReview: false,
          },
        ],
        testResults: [
          {
            testName: "HbA1c",
            value: "8.4",
            unit: "%",
            referenceRange: "< 5.7",
            status: "HIGH",
          },
        ],
        summary: "Clinical summary in Gujarati.",
        summaryEnglish: "Clinical summary in English.",
        summaryInPreferredLanguage: "Clinical summary in Gujarati.",
        summaryLanguage: "gujarati",
        keyPoints: [
          "Diagnosis: Type 2 Diabetes Mellitus",
          "Medication: Telmisartan (1-0-0, OD)",
          "Abnormal Finding: HbA1c: 8.4 % (HIGH)",
        ],
        detectedLanguages: ["gujarati", "english"],
      };

      const parsed = MedicalExtractionSchema.safeParse(payload);
      expect(parsed.success).toBe(true);
      expect(parsed.data.summaryLanguage).toBe("gujarati");
      expect(parsed.data.keyPoints).toHaveLength(3);
      expect(parsed.data.detectedLanguages).toEqual(["gujarati", "english"]);
    });
  });
});
