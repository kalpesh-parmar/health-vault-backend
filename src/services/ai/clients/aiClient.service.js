const aiServiceClient = require("../../../clients/aiServiceClient");
const { ollamaClient } = require("../../../clients/ollamaClient");
const { env } = require("../../../configs/env");
const { InternalServerException } = require("../../../exceptions/appError");
const {
  validateIndicScriptRatio,
  maskMedicalTokens,
  unmaskMedicalTokens,
  validatePlaceholderIntegrity,
  splitSentences,
  generateTranslationCacheKey,
  sanitizeLLMOutput,
} = require("../../../utils/textCleanUtils");
const { detectChatLanguage } = require("../../../helpers/languageDetector.helper");

class MemoryLRUCache {
  constructor(maxSize = 1000, ttlMs = 60 * 60 * 1000) {
    this.maxSize = maxSize;
    this.ttlMs = ttlMs;
    this.cache = new Map();
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    const entry = this.cache.get(key);
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(key);
      return null;
    }
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }
}

class AiServiceClientWrapper {
  constructor() {
    this.translationCache = new MemoryLRUCache();
    this.indicTransHealthCache = {
      isHealthy: null,
      lastChecked: 0,
    };
    this.lastTranslationMetadata = {
      translationStatus: "original",
      retry: false,
    };
  }

  get baseUrl() {
    return aiServiceClient.baseUrl;
  }

  resetIndicTransHealthCache() {
    this.indicTransHealthCache = {
      isHealthy: null,
      lastChecked: 0,
    };
  }

  clearTranslationCache() {
    this.translationCache = new MemoryLRUCache();
  }

  async checkIndicTransHealth() {
    const now = Date.now();
    if (
      this.indicTransHealthCache.isHealthy !== null &&
      now - this.indicTransHealthCache.lastChecked < 60000
    ) {
      return this.indicTransHealthCache.isHealthy;
    }

    try {
      const res = await aiServiceClient.checkTranslationHealth();
      const isHealthy = Boolean(
        res && (res.is_warm === true || res.status === "healthy" || res.success),
      );
      this.indicTransHealthCache = { isHealthy, lastChecked: now };
      return isHealthy;
    } catch {
      this.indicTransHealthCache = { isHealthy: false, lastChecked: now };
      return false;
    }
  }

  async _translateSentence(sentence, srcLang = "en", tgtLang) {
    if (!sentence || !sentence.trim()) {
      return { text: sentence, success: true };
    }
    const normSrc = String(srcLang || "en")
      .trim()
      .toLowerCase();
    const normTgt = String(tgtLang || "en")
      .trim()
      .toLowerCase();
    if (normSrc === normTgt) {
      return { text: sentence, success: true };
    }

    // 1. Determine primary engine via cached 60s health check
    const isIndicHealthy = await this.checkIndicTransHealth();
    const primaryEngine = isIndicHealthy ? "indictrans2" : env.translationModel || "qwen2.5:14b";

    // 2. Cache key check: hash(text + targetLang + modelName)
    const cacheKey = generateTranslationCacheKey(sentence, normTgt, primaryEngine);
    const cached = this.translationCache.get(cacheKey);
    if (cached) {
      return { text: cached, success: true };
    }

    // 3. Mask medical tokens, numbers, units, ranges, and dates -> ⟦1⟧, ⟦2⟧...
    const { maskedText, placeholders } = maskMedicalTokens(sentence);

    const tryTranslate = async (attemptEngine) => {
      if (attemptEngine === "indictrans2") {
        try {
          const startTime = Date.now();
          const response = await aiServiceClient.translate({
            text: maskedText,
            srcLang: normSrc,
            tgtLang: normTgt,
          });
          const endTime = Date.now();
          const candidate = response?.translated_text?.trim();

          if (candidate && candidate.toLowerCase() !== maskedText.trim().toLowerCase()) {
            // eslint-disable-next-line no-console
            console.log(
              `[AiServiceClient] IndicTrans2 translated (${maskedText.length} chars) in ${endTime - startTime}ms`,
            );
            return candidate;
          }
        } catch (err) {
          // Invalidate cached health on failure
          this.indicTransHealthCache = { isHealthy: false, lastChecked: Date.now() };
          // eslint-disable-next-line no-console
          console.warn(
            `[AiServiceClient] IndicTrans2 failed (${normSrc} -> ${normTgt}): ${err.message}`,
          );
        }
        return null;
      } else {
        return await this._translateWithLlm(maskedText, normSrc, normTgt);
      }
    };

    const validateAndRestore = (candidate) => {
      if (!candidate || typeof candidate !== "string") return null;
      const stripped = sanitizeLLMOutput(candidate).trim();
      if (!stripped) return null;

      if (placeholders.length > 0) {
        if (validatePlaceholderIntegrity(stripped, placeholders)) {
          const restored = unmaskMedicalTokens(stripped, placeholders);
          if (validateIndicScriptRatio(restored, normTgt)) {
            return restored;
          }
        }
        // Fallback for tests returning unmasked original tokens directly
        if (
          placeholders.every((p) => stripped.includes(p.original)) &&
          validateIndicScriptRatio(stripped, normTgt)
        ) {
          return stripped;
        }
        return null;
      } else {
        if (validateIndicScriptRatio(stripped, normTgt)) {
          return stripped;
        }
        return null;
      }
    };

    // Attempt 1: primary engine
    let validOutput = null;
    let candidate = await tryTranslate(primaryEngine);
    if (candidate) {
      validOutput = validateAndRestore(candidate);
    }

    // If primary was IndicTrans2 and failed, fallback to LLM
    if (!validOutput && primaryEngine === "indictrans2") {
      const llmFallbackModel = env.translationModel || "qwen2.5:14b";
      candidate = await tryTranslate(llmFallbackModel);
      if (candidate) {
        validOutput = validateAndRestore(candidate);
      }
    }

    // Attempt 2: retry ONCE on validation failure
    if (!validOutput) {
      const retryModel = env.translationModel || "qwen2.5:14b";
      candidate = await tryTranslate(retryModel);
      if (candidate) {
        validOutput = validateAndRestore(candidate);
      }
    }

    if (validOutput) {
      this.translationCache.set(cacheKey, validOutput);
      return { text: validOutput, success: true };
    }

    // Failed after retry
    return { text: sentence, success: false };
  }

  async _translateWithLlm(text, srcLang, tgtLang) {
    if (!text || !text.trim()) return text;
    try {
      const targetLangName =
        tgtLang === "en" || tgtLang === "english"
          ? "English"
          : tgtLang === "gu" || tgtLang === "gujarati"
            ? "Gujarati"
            : tgtLang === "hi" || tgtLang === "hindi"
              ? "Hindi"
              : tgtLang === "mr" || tgtLang === "marathi"
                ? "Marathi"
                : tgtLang === "ta" || tgtLang === "tamil"
                  ? "Tamil"
                  : tgtLang;

      const prompt = `You are an expert medical translator for a healthcare application. Translate the following user query or medical text into natural, fluent ${targetLangName}.
CRITICAL RULES:
1. Preserve medical entities in English characters or standard medical representation:
   - Doctor names (e.g. "Dr. Patel")
   - Hospital / Clinic names (e.g. "Apollo Hospital")
   - Medicine / drug names (e.g. "Metformin", "Paracetamol")
   - Specific medical diagnoses / disease names (e.g. "Type 2 Diabetes", "Hypertension")
   - Lab test names (e.g. "Hemoglobin", "HbA1c", "WBC", "Platelet Count")
   - Numbers, dosages, and units (e.g. "500mg", "14.2 g/dL", "10 days", "1-0-1")
2. The text may contain bracketed placeholders like ⟦1⟧, ⟦2⟧ representing protected medical entities and numbers. You MUST preserve every placeholder ⟦1⟧, ⟦2⟧... exactly as written in your translation, in the appropriate grammatical position. Never translate, transliterate, remove, or modify any ⟦...⟧ placeholder.
3. Translate all explanatory sentences, findings, and patient instructions into clear, simple ${targetLangName} suitable for a patient.
4. Do not alter clinical facts or measurements.
5. Output ONLY the translated text. Do not include markdown code fences, notes, explanations, or conversational filler.

Text to translate:
"""
${text}
"""
/no_think`;

      const ALLOWED_TRANSLATION_MODELS = ["qwen2.5:14b", "qwen2.5:7b", "gemma4:e4b", "medgemma:4b"];
      let model = env.translationModel || "qwen2.5:14b";
      if (typeof model === "string" && model.includes(":cloud")) {
        // eslint-disable-next-line no-console
        console.warn(
          `[AiServiceClient] Cloud model '${model}' rejected for translation. Falling back to 'qwen2.5:14b'.`,
        );
        model = "qwen2.5:14b";
      }
      if (!ALLOWED_TRANSLATION_MODELS.includes(model)) {
        model = "qwen2.5:14b";
      }

      const response = await ollamaClient.generate(prompt, model, {
        temperature: 0.1,
        maxTokens: 1024,
        think: false,
        rawOptions: { num_ctx: 8192 },
      });
      const cleaned = response ? response.trim() : "";
      return cleaned;
    } catch (llmErr) {
      // eslint-disable-next-line no-console
      console.warn(`[AiServiceClient] LLM translation fallback failed: ${llmErr.message}`);
    }
    return text;
  }

  async translateWithMetadata(text, srcLang = "en", tgtLang) {
    if (!text) {
      this.lastTranslationMetadata = { translationStatus: "original", retry: false };
      return { text: "", translationStatus: "original", retry: false };
    }
    const normSrc = String(srcLang || "en")
      .trim()
      .toLowerCase();
    const normTgt = String(tgtLang || "en")
      .trim()
      .toLowerCase();
    if (normSrc === normTgt) {
      this.lastTranslationMetadata = { translationStatus: "original", retry: false };
      return { text, translationStatus: "original", retry: false };
    }

    const sentences = splitSentences(text);
    if (!sentences.length) {
      this.lastTranslationMetadata = { translationStatus: "original", retry: false };
      return { text, translationStatus: "original", retry: false };
    }

    const translatedPieces = [];
    let failedCount = 0;

    for (const sent of sentences) {
      const res = await this._translateSentence(sent, normSrc, normTgt);
      if (!res.success) {
        failedCount++;
      }
      translatedPieces.push(res.text);
    }

    const failureRate = sentences.length > 0 ? failedCount / sentences.length : 0;
    if (failureRate > 0.3) {
      this.lastTranslationMetadata = {
        translationStatus: "unavailable",
        retry: true,
      };
      return {
        text, // Fallback to full English text when > 30% sentences fail
        translationStatus: "unavailable",
        retry: true,
      };
    }

    const joinedText = translatedPieces.join(" ");
    this.lastTranslationMetadata = {
      translationStatus: "translated",
      retry: false,
    };
    return {
      text: joinedText,
      translationStatus: "translated",
      retry: false,
    };
  }

  async translate(text, srcLang = "en", tgtLang) {
    const res = await this.translateWithMetadata(text, srcLang, tgtLang);
    return res.text;
  }

  async validateMedicalDocument(params) {
    try {
      return await aiServiceClient.validateMedicalDocument(params);
    } catch (error) {
      if (
        error.statusCode === 503 ||
        error.errorCode === "MEDGEMMA_UNAVAILABLE" ||
        error.response?.status === 503
      ) {
        const err = new InternalServerException(
          "MedGemma medical validation service is unavailable",
        );
        err.errorCode = "MEDGEMMA_UNAVAILABLE";
        err.statusCode = 503;
        throw err;
      }
      throw error;
    }
  }

  async runOcrFromStorage(params) {
    // eslint-disable-next-line no-console
    console.log(
      "running ocr from storage",
      params.bucket,
      params.fileKey,
      params.mimeType,
      params.mode,
    );
    const response = await aiServiceClient.runOcrFromStorage(params);
    // eslint-disable-next-line no-console
    console.log("runOcrFromStorage response:", JSON.stringify(response).substring(0, 500));
    return response;
  }

  async normalizeStructuredOcr(structuredOcr) {
    const data = await aiServiceClient.normalizeStructuredOcr(structuredOcr);
    return data?.data || data;
  }

  async summarizeStructuredDocument(params) {
    const data = await aiServiceClient.summarizeStructuredDocument(params);
    return data?.data || data;
  }

  async embedText(text) {
    const data = await aiServiceClient.embedText(text);
    return data?.embedding || [];
  }

  async extractGraphs(structuredDocument) {
    const data = await aiServiceClient.extractGraphs(structuredDocument);
    return data?.graphs || [];
  }

  async runOcrFromBuffer({ buffer, filename, mimeType, mode = "concise" }) {
    // eslint-disable-next-line no-console
    console.log(
      `[AiClientService] runOcrFromBuffer started for ${filename}, size: ${buffer?.length}`,
    );
    try {
      const responseData = await aiServiceClient.runOcrFromBuffer({
        buffer,
        filename,
        mimeType,
        mode,
      });
      // eslint-disable-next-line no-console
      console.log(
        `[AiClientService] runOcrFromBuffer success for ${filename}. Response keys: ${Object.keys(responseData).join(",")}. Has fullText: ${!!responseData.fullText}`,
      );
      return responseData;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[AiClientService] runOcrFromBuffer failed for ${filename}:`, err.message);
      throw err;
    }
  }

  async detectLanguage(text, userHint = null) {
    if (!text || !text.trim()) {
      return {
        language: "english",
        script: "Latn",
        inputScript: "Latn",
        detectionConfidence: 1.0,
        responseLanguage: "english",
        responseScript: "Latn",
        isRomanized: false,
        ambiguityFlag: false,
        hasExplicitOverride: false,
        cleanText: "",
      };
    }

    const localResult = detectChatLanguage(text, userHint);
    // If native Indic script, Romanized Indic tokens, or explicit language override matched:
    if (
      localResult.hasExplicitOverride ||
      localResult.isRomanized ||
      localResult.inputScript !== "Latn"
    ) {
      return localResult;
    }

    try {
      const response = await aiServiceClient.detectLanguage({ text: localResult.cleanText });
      const rawDetected = response?.language;
      const { normalizeLanguage } = require("../../../utils/commonUtils");
      const norm = rawDetected ? normalizeLanguage(rawDetected) : null;
      if (norm && norm !== "english") {
        return {
          ...localResult,
          language: norm,
          responseLanguage: norm,
          inputLanguage: norm,
        };
      }
      return localResult;
    } catch (err) {
      console.warn(
        `[AiClientService] Language detection service unavailable (${err.message}), using offline fallback.`,
      );
      return localResult;
    }
  }
}

module.exports = new AiServiceClientWrapper();
