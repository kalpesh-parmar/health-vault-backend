const FormData = require("form-data");
const axios = require("axios");

const { env } = require("../../../configs/env");
const { InternalServerException } = require("../../../exceptions/appError");

const DEFAULT_TIMEOUT = 300 * 1000; // Increased to 5 minutes for heavy OCR/Vision tasks
const TRANSIENT_STATUS = new Set([502, 503, 504]);

function shouldRetry(error) {
  if (!error.response) return true;
  return TRANSIENT_STATUS.has(error.response.status);
}

async function postWithRetry(url, body, { headers, timeout = DEFAULT_TIMEOUT, retries = 1 } = {}) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const response = await axios.post(url, body, { headers, timeout });
      return response.data;
    } catch (error) {
      lastError = error;
      if (!shouldRetry(error) || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
  const status = lastError.response?.status || 502;
  const detail = lastError.response?.data?.error || lastError.message;
  throw new InternalServerException(`AI service request failed (${status}): ${detail}`);
}

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
    // Refresh insertion order (LRU)
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict oldest (first key in map iterator)
      const oldestKey = this.cache.keys().next().value;
      this.cache.delete(oldestKey);
    }
    this.cache.set(key, { value, timestamp: Date.now() });
  }
}

class AiServiceClient {
  constructor() {
    this.translationCache = new MemoryLRUCache();
  }

  get baseUrl() {
    return env.aiServiceUrl;
  }

  async _translateChunk(text, srcLang = "en", tgtLang) {
    if (!text || srcLang === tgtLang) return text;
    const cacheKey = `${srcLang}:${tgtLang}:${text}`;
    const cached = this.translationCache.get(cacheKey);
    if (cached) return cached;

    console.log(
      `[AiServiceClient] Calling IndicTrans2 model to translate chunk (${text.length} chars) from ${srcLang} to ${tgtLang}...`,
    );
    try {
      const startTime = Date.now();
      const response = await postWithRetry(
        `${this.baseUrl}/api/v1/translate`,
        {
          text,
          src_lang: srcLang,
          tgt_lang: tgtLang,
        },
        { timeout: 300000, retries: 0 },
      );
      const endTime = Date.now();
      console.log(`[AiServiceClient] Translation API call took ${endTime - startTime}ms`);

      const translatedText = response?.translated_text || text;
      this.translationCache.set(cacheKey, translatedText);
      return translatedText;
    } catch (err) {
      console.error(
        `[AiServiceClient] Translation failed from ${srcLang} to ${tgtLang}:`,
        err.message,
      );
      return text; // Fallback to original text
    }
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

  async runOcrFromStorage({ bucket, fileKey, mimeType, mode = "concise" }) {
    console.log("running ocr from storage", bucket, fileKey, mimeType, mode);

    const response = await postWithRetry(`${this.baseUrl}/v1/run-ocr`, {
      bucket,
      fileKey,
      mimeType,
      mode,
    });

    console.log("runOcrFromStorage response:", JSON.stringify(response).substring(0, 500)); // Log first 500 chars to avoid huge logs
    return response;
  }

  async normalizeStructuredOcr(structuredOcr) {
    const data = await postWithRetry(`${this.baseUrl}/v1/extraction/normalize`, { structuredOcr });
    return data?.data || data;
  }

  async summarizeStructuredDocument({
    structuredDocument,
    patientContext,
    medications = [],
    medicalEntities = [],
  }) {
    const data = await postWithRetry(`${this.baseUrl}/v1/extraction/summarize`, {
      structuredDocument,
      patientContext,
      medications,
      medicalEntities,
    });
    return data?.data || data;
  }

  async embedText(text) {
    const data = await postWithRetry(`${this.baseUrl}/v1/embeddings`, { text });
    return data?.embedding || [];
  }

  async extractGraphs(structuredDocument) {
    const data = await postWithRetry(`${this.baseUrl}/v1/extraction/graphs`, {
      structuredDocument,
    });
    return data?.graphs || [];
  }

  async runOcrFromBuffer({ buffer, filename, mimeType, mode = "concise" }) {
    console.log(
      `[AiClientService] runOcrFromBuffer started for ${filename}, size: ${buffer?.length}`,
    );
    const form = new FormData();
    form.append("file", buffer, { contentType: mimeType, filename });
    form.append("mode", mode);

    try {
      const response = await axios.post(`${this.baseUrl}/v1/run-ocr`, form, {
        headers: form.getHeaders(),
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: DEFAULT_TIMEOUT,
      });
      console.log(
        `[AiClientService] runOcrFromBuffer success for ${filename}. Response keys: ${Object.keys(response.data).join(",")}. Has fullText: ${!!response.data.fullText}`,
      );
      return response.data;
    } catch (err) {
      console.error(`[AiClientService] runOcrFromBuffer failed for ${filename}:`, err.message);
      throw err;
    }
  }
}

module.exports = new AiServiceClient();
