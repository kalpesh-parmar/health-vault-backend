const { ocrService } = require("../../src/services/ai/ocr/ocr.service");
const aiClient = require("../../src/services/ai/clients/aiClient.service");
const aiServiceClient = require("../../src/clients/aiServiceClient");
const { ollamaClient } = require("../../src/clients/ollamaClient");
const { normalizeLanguage } = require("../../src/utils/commonUtils");

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

      // Mock aiServiceClient.translate to return untranslated source text (mimicking HF_TOKEN failure)
      jest.spyOn(aiServiceClient, "translate").mockResolvedValue({
        translated_text: sourceText,
      });

      // Mock ollamaClient.generate for LLM fallback
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
});
