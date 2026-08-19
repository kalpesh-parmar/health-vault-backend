const aiServiceClient = require("../../../clients/aiServiceClient");
const { InternalServerException } = require("../../../exceptions/appError");

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
  }

  get baseUrl() {
    return aiServiceClient.baseUrl;
  }

  async translate(text, srcLang = "en", tgtLang) {
    if (!text || srcLang === tgtLang) return text;
    const cacheKey = `${srcLang}:${tgtLang}:${text}`;
    const cached = this.translationCache.get(cacheKey);
    if (cached) return cached;

    try {
      const response = await aiServiceClient.translate({ text, srcLang, tgtLang });
      const translatedText = response?.translated_text || text;
      this.translationCache.set(cacheKey, translatedText);
      return translatedText;
    } catch (err) {
      console.error(
        `[AiServiceClient] Translation failed from ${srcLang} to ${tgtLang}:`,
        err.message,
      );
      return text;
    }
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
    console.log(
      "running ocr from storage",
      params.bucket,
      params.fileKey,
      params.mimeType,
      params.mode,
    );
    const response = await aiServiceClient.runOcrFromStorage(params);
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
      console.log(
        `[AiClientService] runOcrFromBuffer success for ${filename}. Response keys: ${Object.keys(responseData).join(",")}. Has fullText: ${!!responseData.fullText}`,
      );
      return responseData;
    } catch (err) {
      console.error(`[AiClientService] runOcrFromBuffer failed for ${filename}:`, err.message);
      throw err;
    }
  }
}

module.exports = new AiServiceClientWrapper();
