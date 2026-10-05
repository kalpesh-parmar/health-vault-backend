const crypto = require("crypto");
const {
  maskMedicalTokens,
  unmaskMedicalTokens,
  validatePlaceholderIntegrity,
  splitSentences,
  generateTranslationCacheKey,
} = require("../../src/utils/textCleanUtils");

const aiClient = require("../../src/services/ai/clients/aiClient.service");
const aiServiceClient = require("../../src/clients/aiServiceClient");
const { ollamaClient } = require("../../src/clients/ollamaClient");

describe("Commit 1E - Translation Safety, Placeholder Masking, and Health Checks", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    aiClient.resetIndicTransHealthCache?.();
    aiClient.clearTranslationCache?.();
  });

  afterEach(() => {
    jest.restoreAllMocks();
    aiClient.resetIndicTransHealthCache?.();
    aiClient.clearTranslationCache?.();
  });

  describe("1. Medical Token and Entity Masking", () => {
    test("masks medical tokens, numbers, units, ranges, and dates into ⟦1⟧, ⟦2⟧ placeholders", () => {
      const input =
        "Patient HbA1c is 8.5% on 15-Jan-2026. Normal range is 4.0 - 5.6%. Prescribed Metformin 500mg.";
      const { maskedText, placeholders } = maskMedicalTokens(input);

      // Verify placeholder syntax uses mathematical brackets ⟦1⟧, ⟦2⟧...
      expect(maskedText).toContain("⟦1⟧");
      expect(maskedText).toContain("⟦2⟧");
      expect(placeholders.length).toBeGreaterThanOrEqual(4);

      // Verify specific tokens were captured in order
      const originalTokens = placeholders.map((p) => p.original);
      expect(originalTokens).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/HbA1c/i),
          expect.stringMatching(/8\.5%/),
          expect.stringMatching(/15-Jan-2026/),
          expect.stringMatching(/4\.0\s*-\s*5\.6%/),
          expect.stringMatching(/Metformin/i),
          expect.stringMatching(/500mg/),
        ]),
      );
    });

    test("restores masked placeholders accurately using unmaskMedicalTokens", () => {
      const input = "HbA1c is 8.5% and TSH is 2.5 uIU/mL.";
      const { maskedText, placeholders } = maskMedicalTokens(input);

      // Simulate translated sentence keeping the placeholders
      const mockTranslated = maskedText
        .replace("is", "એ")
        .replace("and", "અને")
        .replace(".", " છે.");

      const restored = unmaskMedicalTokens(mockTranslated, placeholders);
      expect(restored).toContain("HbA1c");
      expect(restored).toContain("8.5%");
      expect(restored).toContain("TSH");
      expect(restored).toContain("2.5 uIU/mL");
      expect(restored).not.toContain("⟦");
      expect(restored).not.toContain("⟧");
    });
  });

  describe("2. Placeholder Integrity Validation", () => {
    test("passes when all placeholders are preserved exactly once", () => {
      const placeholders = [
        { placeholder: "⟦1⟧", index: 1, original: "HbA1c" },
        { placeholder: "⟦2⟧", index: 2, original: "8.5%" },
      ];
      const validTranslation = "દર્દીનું ⟦1⟧ સ્તર ⟦2⟧ છે.";
      expect(validatePlaceholderIntegrity(validTranslation, placeholders)).toBe(true);
    });

    test("rejects translation when a placeholder is missing", () => {
      const placeholders = [
        { placeholder: "⟦1⟧", index: 1, original: "HbA1c" },
        { placeholder: "⟦2⟧", index: 2, original: "8.5%" },
      ];
      // Missing ⟦1⟧
      const missingTranslation = "દર્દીનું સ્તર ⟦2⟧ છે.";
      expect(validatePlaceholderIntegrity(missingTranslation, placeholders)).toBe(false);
    });

    test("rejects translation when a placeholder is duplicated", () => {
      const placeholders = [
        { placeholder: "⟦1⟧", index: 1, original: "HbA1c" },
        { placeholder: "⟦2⟧", index: 2, original: "8.5%" },
      ];
      // Duplicated ⟦1⟧
      const duplicatedTranslation = "દર્દીનું ⟦1⟧ અને ⟦1⟧ સ્તર ⟦2⟧ છે.";
      expect(validatePlaceholderIntegrity(duplicatedTranslation, placeholders)).toBe(false);
    });

    test("rejects translation when extra/unknown placeholders are hallucinated", () => {
      const placeholders = [
        { placeholder: "⟦1⟧", index: 1, original: "HbA1c" },
        { placeholder: "⟦2⟧", index: 2, original: "8.5%" },
      ];
      // Hallucinated ⟦3⟧
      const extraTranslation = "દર્દીનું ⟦1⟧ સ્તર ⟦2⟧ અને ⟦3⟧ છે.";
      expect(validatePlaceholderIntegrity(extraTranslation, placeholders)).toBe(false);
    });
  });

  describe("3. Sentence Splitting", () => {
    test("splits multi-sentence clinical text without breaking on decimal numbers", () => {
      const text =
        "The patient presents with HbA1c at 7.5% today. Blood pressure is 120/80 mmHg. Prescribed Metformin 500mg!";
      const sentences = splitSentences(text);
      expect(sentences).toHaveLength(3);
      expect(sentences[0]).toBe("The patient presents with HbA1c at 7.5% today.");
      expect(sentences[1]).toBe("Blood pressure is 120/80 mmHg.");
      expect(sentences[2]).toBe("Prescribed Metformin 500mg!");
    });
  });

  describe("4. Translation Cache Key", () => {
    test("generates sha256 hash of text + targetLang + modelName", () => {
      const text = "Patient has normal Hemoglobin.";
      const targetLang = "gujarati";
      const modelName = "qwen2.5:14b";

      const key = generateTranslationCacheKey(text, targetLang, modelName);
      const expectedHash = crypto
        .createHash("sha256")
        .update(
          `${text.trim()}:${targetLang.trim().toLowerCase()}:${modelName.trim().toLowerCase()}`,
        )
        .digest("hex");

      expect(key).toBe(expectedHash);
      expect(key).toHaveLength(64);

      // Key must differ if model differs
      const keyOtherModel = generateTranslationCacheKey(text, targetLang, "indictrans2");
      expect(key).not.toBe(keyOtherModel);
    });
  });

  describe("5. IndicTrans2 60s Cached Health Check", () => {
    test("checks IndicTrans2 health and caches result for 60 seconds", async () => {
      const healthSpy = jest.spyOn(aiServiceClient, "checkTranslationHealth").mockResolvedValue({
        status: "healthy",
        is_warm: true,
      });

      // First check calls the endpoint
      const firstCheck = await aiClient.checkIndicTransHealth();
      expect(firstCheck).toBe(true);
      expect(healthSpy).toHaveBeenCalledTimes(1);

      // Second check within 60s uses cached result
      const secondCheck = await aiClient.checkIndicTransHealth();
      expect(secondCheck).toBe(true);
      expect(healthSpy).toHaveBeenCalledTimes(1);
    });

    test("bypasses IndicTrans2 when health check fails and avoids calling it within 60s TTL", async () => {
      const healthSpy = jest
        .spyOn(aiServiceClient, "checkTranslationHealth")
        .mockRejectedValue(new Error("Connection refused"));

      const isHealthy = await aiClient.checkIndicTransHealth();
      expect(isHealthy).toBe(false);
      expect(healthSpy).toHaveBeenCalledTimes(1);

      // Calling again within 60s does not retry the failing endpoint
      const isHealthyCached = await aiClient.checkIndicTransHealth();
      expect(isHealthyCached).toBe(false);
      expect(healthSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("6. Per-Sentence Translation, Validation & Retry Fallback", () => {
    test("translates per sentence, restores placeholders, and joins output", async () => {
      jest.spyOn(aiClient, "checkIndicTransHealth").mockResolvedValue(false);

      const sentence1 = "Patient HbA1c is 8.5%.";
      const sentence2 = "Prescribed Metformin 500mg.";
      const fullText = `${sentence1} ${sentence2}`;

      // Mock Ollama generation preserving placeholders
      jest
        .spyOn(ollamaClient, "generate")
        .mockResolvedValueOnce("દર્દીનું ⟦1⟧ સ્તર ⟦2⟧ છે.")
        .mockResolvedValueOnce("⟦1⟧ ⟦2⟧ લેવાની સલાહ આપવામાં આવે છે.");

      const result = await aiClient.translateWithMetadata(fullText, "english", "gujarati");

      expect(result.translationStatus).toBe("translated");
      expect(result.retry).toBe(false);
      expect(result.text).toContain("HbA1c");
      expect(result.text).toContain("8.5%");
      expect(result.text).toContain("Metformin");
      expect(result.text).toContain("500mg");
      expect(result.text).not.toContain("⟦");
    });

    test("retries once on placeholder validation failure, then falls back to English with translationStatus unavailable", async () => {
      jest.spyOn(aiClient, "checkIndicTransHealth").mockResolvedValue(false);

      const text = "Patient HbA1c is 8.5%.";

      // 1st attempt: drops placeholder ⟦1⟧
      // 2nd attempt (retry): also drops placeholder ⟦1⟧
      jest
        .spyOn(ollamaClient, "generate")
        .mockResolvedValueOnce("દર્દીનું સ્તર ⟦2⟧ છે.") // missing ⟦1⟧
        .mockResolvedValueOnce("દર્દીનું સ્તર ⟦2⟧ છે."); // retry also fails

      const result = await aiClient.translateWithMetadata(text, "english", "gujarati");

      expect(ollamaClient.generate).toHaveBeenCalledTimes(2);
      expect(result.translationStatus).toBe("unavailable");
      expect(result.retry).toBe(true);
      expect(result.text).toBe(text); // returns original English
    });

    test("succeeds on retry if second attempt satisfies placeholder integrity", async () => {
      jest.spyOn(aiClient, "checkIndicTransHealth").mockResolvedValue(false);

      const text = "Patient HbA1c is 8.5%.";

      // 1st attempt: corrupted placeholder
      // 2nd attempt (retry): valid output preserving ⟦1⟧ and ⟦2⟧
      jest
        .spyOn(ollamaClient, "generate")
        .mockResolvedValueOnce("ખરાબ આઉટપુટ જેમાં કોઈ પ્લેસહોલ્ડર નથી.")
        .mockResolvedValueOnce("દર્દીનું ⟦1⟧ સ્તર ⟦2⟧ છે.");

      const result = await aiClient.translateWithMetadata(text, "english", "gujarati");

      expect(ollamaClient.generate).toHaveBeenCalledTimes(2);
      expect(result.translationStatus).toBe("translated");
      expect(result.retry).toBe(false);
      expect(result.text).toContain("HbA1c");
      expect(result.text).toContain("8.5%");
    });
  });
});
