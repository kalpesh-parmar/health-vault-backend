const aiServiceClient = require("../../../clients/aiServiceClient");
const { ollamaClient } = require("../../../clients/ollamaClient");
const { env } = require("../../../configs/env");
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

  async _translateChunk(text, srcLang = "en", tgtLang) {
    if (!text) return text;
    const normSrc = String(srcLang || "en")
      .trim()
      .toLowerCase();
    const normTgt = String(tgtLang || "en")
      .trim()
      .toLowerCase();
    if (normSrc === normTgt) return text;

    const cacheKey = `${normSrc}:${normTgt}:${text}`;
    const cached = this.translationCache.get(cacheKey);
    if (cached) return cached;

    // 1. Attempt IndicTrans2 via ai-service
    let translatedText = null;
    try {
      const startTime = Date.now();
      const response = await aiServiceClient.translate({
        text,
        srcLang: normSrc,
        tgtLang: normTgt,
      });
      const endTime = Date.now();
      const candidate = response?.translated_text?.trim();

      // Ensure IndicTrans2 actually performed translation rather than echoing unchanged source text
      if (candidate && candidate.toLowerCase() !== text.trim().toLowerCase()) {
        translatedText = candidate;
        // eslint-disable-next-line no-console
        console.log(
          `[AiServiceClient] IndicTrans2 translated (${text.length} chars) in ${endTime - startTime}ms`,
        );
      } else {
        // eslint-disable-next-line no-console
        console.log(
          `[AiServiceClient] IndicTrans2 returned unchanged text or was un-warmed. Triggering LLM translation fallback.`,
        );
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(
        `[AiServiceClient] IndicTrans2 unavailable (${normSrc} -> ${normTgt}): ${err.message}. Falling back to LLM.`,
      );
    }

    // 2. Resilient fallback to Ollama / Qwen model
    if (!translatedText) {
      translatedText = await this._translateWithLlm(text, normSrc, normTgt);
    }

    const finalResult = translatedText || text;
    this.translationCache.set(cacheKey, finalResult);
    return finalResult;
  }

  async _translateWithLlm(text, srcLang, tgtLang) {
    if (!text || !text.trim()) return text;
    try {
      const targetLangName =
        tgtLang === "gu" || tgtLang === "gujarati"
          ? "Gujarati"
          : tgtLang === "hi" || tgtLang === "hindi"
            ? "Hindi"
            : tgtLang === "mr" || tgtLang === "marathi"
              ? "Marathi"
              : tgtLang === "ta" || tgtLang === "tamil"
                ? "Tamil"
                : tgtLang;

      const prompt = `You are an expert medical translator for a healthcare application. Translate the following medical report/prescription summary into natural, fluent ${targetLangName}.
CRITICAL RULES:
1. Preserve medical entities in English characters or standard medical representation:
   - Doctor names (e.g. "Dr. Patel")
   - Hospital / Clinic names (e.g. "Apollo Hospital")
   - Medicine / drug names (e.g. "Metformin", "Paracetamol")
   - Specific medical diagnoses / disease names (e.g. "Type 2 Diabetes", "Hypertension")
   - Lab test names (e.g. "Hemoglobin", "HbA1c", "WBC", "Platelet Count")
   - Numbers, dosages, and units (e.g. "500mg", "14.2 g/dL", "10 days", "1-0-1")
2. Translate all explanatory sentences, findings, and patient instructions into clear, simple ${targetLangName} suitable for a patient.
3. Do not alter clinical facts or measurements.
4. Output ONLY the translated text. Do not include markdown code fences, notes, explanations, or conversational filler.

Text to translate:
"""
${text}
"""
/no_think`;

      const model = env.aiModel || "qwen3-vl:latest";
      const response = await ollamaClient.generate(prompt, model, {
        temperature: 0.1,
        maxTokens: 1024,
        think: false,
        rawOptions: { num_ctx: 8192 },
      });
      const cleaned = response ? response.trim() : "";
      if (cleaned) {
        return cleaned;
      }
    } catch (llmErr) {
      // eslint-disable-next-line no-console
      console.warn(`[AiServiceClient] LLM translation fallback failed: ${llmErr.message}`);
    }
    return text;
  }

  async translate(text, srcLang = "en", tgtLang) {
    if (!text || srcLang === tgtLang) return text;

    // Check if the text is short enough to translate in one go
    if (text.length <= 4000) {
      return await this._translateChunk(text, srcLang, tgtLang);
    }

    // Otherwise, split the text into manageable paragraphs and translate them sequentially
    const chunks = text.split("\n\n");

    const chunkPromises = chunks.map(async (chunk) => {
      if (!chunk.trim()) {
        return chunk;
      }

      // If a single paragraph is still absurdly long, split by single newline
      if (chunk.length > 4000) {
        const subChunks = chunk.split("\n");
        const subChunkPromises = subChunks.map(async (subChunk) => {
          if (!subChunk.trim()) {
            return subChunk;
          }
          return await this._translateChunk(subChunk, srcLang, tgtLang);
        });
        const translatedSubChunks = await Promise.all(subChunkPromises);
        return translatedSubChunks.join("\n");
      } else {
        // Translate normal paragraph
        return await this._translateChunk(chunk, srcLang, tgtLang);
      }
    });

    const translatedChunks = await Promise.all(chunkPromises);
    return translatedChunks.join("\n\n");
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

  async detectLanguage(text) {
    if (!text || !text.trim()) return "english";
    try {
      const response = await aiServiceClient.detectLanguage({ text });
      return response?.language || "english";
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[AiClientService] Language detection failed:`, err.message);
      return "english";
    }
  }
}

module.exports = new AiServiceClientWrapper();
