const {
  extractLanguageOverride,
  detectChatLanguage,
} = require("../../src/helpers/languageDetector.helper");
const aiClient = require("../../src/services/ai/clients/aiClient.service");

describe("Phase 1: Multilingual and Romanized Language Pipeline", () => {
  describe("1. Explicit Response-Language Override", () => {
    test("detects English override in Gujarati transliterated query", () => {
      const input = "Mara report ni summary English ma apo";
      const result = extractLanguageOverride(input);
      expect(result.hasOverride).toBe(true);
      expect(result.targetLanguage).toBe("english");
      expect(result.cleanText).toBe("Mara report ni summary apo");
    });

    test("detects English override with 'in english'", () => {
      const input = "What was my HbA1c in english?";
      const result = extractLanguageOverride(input);
      expect(result.hasOverride).toBe(true);
      expect(result.targetLanguage).toBe("english");
    });

    test("detects Hindi override with 'hindi me'", () => {
      const input = "Report ka result hindi me samjhao";
      const result = extractLanguageOverride(input);
      expect(result.hasOverride).toBe(true);
      expect(result.targetLanguage).toBe("hindi");
      expect(result.cleanText).toBe("Report ka result samjhao");
    });

    test("detects Marathi override with 'marathi madhe'", () => {
      const input = "Majhya report cha arth marathi madhe sanga";
      const result = extractLanguageOverride(input);
      expect(result.hasOverride).toBe(true);
      expect(result.targetLanguage).toBe("marathi");
    });

    test("returns false when no explicit override directive is present", () => {
      const input = "Mara report ni summary apo";
      const result = extractLanguageOverride(input);
      expect(result.hasOverride).toBe(false);
      expect(result.targetLanguage).toBeNull();
      expect(result.cleanText).toBe(input);
    });
  });

  describe("2. Offline Detection of Native Scripts & Romanized Indic", () => {
    test("accurately identifies Native Gujarati", () => {
      const res = detectChatLanguage("મારા રિપોર્ટનો સારાંશ આપો");
      expect(res.language).toBe("gujarati");
      expect(res.responseScript).toBe("Gujr");
      expect(res.isRomanized).toBe(false);
    });

    test("accurately identifies Native Hindi", () => {
      const res = detectChatLanguage("मेरी रिपोर्ट समझाओ");
      expect(res.language).toBe("hindi");
      expect(res.responseScript).toBe("Deva");
      expect(res.isRomanized).toBe(false);
    });

    test("accurately identifies Native Marathi (using ळ or distinctive words)", () => {
      const res = detectChatLanguage("माझ्या रिपोर्टचा सारांश सांगा");
      expect(res.language).toBe("marathi");
      expect(res.responseScript).toBe("Deva");
    });

    test("accurately identifies Native Tamil", () => {
      const res = detectChatLanguage("என் அறிக்கையின் சுருக்கத்தை சொல்லுங்கள்");
      expect(res.language).toBe("tamil");
      expect(res.responseScript).toBe("Taml");
      expect(res.isRomanized).toBe(false);
    });

    test("accurately identifies Romanized Gujarati", () => {
      const res = detectChatLanguage("Mara report ni summary apo");
      expect(res.language).toBe("gujarati");
      expect(res.isRomanized).toBe(true);
    });

    test("accurately identifies Romanized Hindi", () => {
      const res = detectChatLanguage("Mere report ki summary batao");
      expect(res.language).toBe("hindi");
      expect(res.isRomanized).toBe(true);
    });

    test("accurately identifies Romanized Marathi", () => {
      const res = detectChatLanguage("Majhya report cha summary sanga");
      expect(res.language).toBe("marathi");
      expect(res.isRomanized).toBe(true);
    });

    test("accurately identifies Romanized Tamil", () => {
      const res = detectChatLanguage("En report summary sollunga");
      expect(res.language).toBe("tamil");
      expect(res.isRomanized).toBe(true);
    });

    test("correctly assigns English for standard English questions", () => {
      const res = detectChatLanguage("What is my report summary?");
      expect(res.language).toBe("english");
      expect(res.isRomanized).toBe(false);
    });

    test("applies explicit override in detectChatLanguage", () => {
      const res = detectChatLanguage("Mara report ni summary English ma apo");
      expect(res.language).toBe("english");
      expect(res.hasExplicitOverride).toBe(true);
      expect(res.cleanText).toBe("Mara report ni summary apo");
    });
  });

  describe("3. AiClient detectLanguage Integration", () => {
    test("preserves metadata object with confidence, script, and language", async () => {
      const res = await aiClient.detectLanguage("Mara report ni summary apo");
      expect(res).toHaveProperty("language");
      expect(res).toHaveProperty("detectionConfidence");
      expect(res).toHaveProperty("inputScript");
      expect(res.language).toBe("gujarati");
    });

    test("honors explicit language override through aiClient", async () => {
      const res = await aiClient.detectLanguage("Mara report ni summary English ma apo");
      expect(res.language).toBe("english");
      expect(res.hasExplicitOverride).toBe(true);
      expect(res.cleanText).toBe("Mara report ni summary apo");
    });
  });
});
