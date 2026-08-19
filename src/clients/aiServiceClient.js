const FormData = require("form-data");
const { createHttpClient } = require("../configs/http.config");
const apiConfig = require("../configs/api.config");
const { env } = require("../configs/env");
const { InternalServerException } = require("../exceptions/appError");

const DEFAULT_TIMEOUT = 300 * 1000;
const TRANSIENT_STATUS = new Set([502, 503, 504]);

function shouldRetry(error) {
  if (!error.response) return true;
  return TRANSIENT_STATUS.has(error.response.status);
}

class AiServiceClient {
  constructor() {
    this.client = createHttpClient({
      baseURL: apiConfig.aiService.baseURL,
      timeout: apiConfig.aiService.timeout,
    });
    this.endpoints = apiConfig.aiService.endpoints;
  }

  get baseUrl() {
    return apiConfig.aiService.baseURL;
  }

  async postWithRetry(endpoint, body, { headers, timeout = DEFAULT_TIMEOUT, retries = 1 } = {}) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.client.post(endpoint, body, { headers, timeout });
        return response.data;
      } catch (error) {
        lastError = error;
        if (!shouldRetry(error) || attempt === retries) break;
        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }
    const status = lastError.response?.status || 502;
    const detail =
      lastError.response?.data?.detail || lastError.response?.data?.error || lastError.message;
    const detailStr = typeof detail === "object" ? JSON.stringify(detail) : detail;
    const err = new InternalServerException(`AI service request failed (${status}): ${detailStr}`);
    err.statusCode = status;
    err.response = lastError.response;
    if (typeof detail === "object" && detail?.code) {
      err.errorCode = detail.code;
    } else if (lastError.response?.data?.code) {
      err.errorCode = lastError.response.data.code;
    }
    throw err;
  }

  async translate({ text, srcLang = "en", tgtLang }) {
    return this.postWithRetry(
      this.endpoints.translate,
      {
        text,
        src_lang: srcLang,
        tgt_lang: tgtLang,
      },
      { timeout: 30000, retries: 2 },
    );
  }

  async validateMedicalDocument({ file, fileName, mimeType }) {
    const formData = new FormData();

    formData.append("file", file, {
      filename: fileName,
      contentType: mimeType,
    });

    return this.postWithRetry(this.endpoints.validateMedical, formData, {
      timeout: env.medgemmaTimeoutMs,
      retries: 1,
      headers: formData.getHeaders(),
    });
  }

  async runOcrFromStorage({ bucket, fileKey, mimeType, mode = "concise" }) {
    return this.postWithRetry(this.endpoints.runOcr, {
      bucket,
      fileKey,
      mimeType,
      mode,
    });
  }

  async normalizeStructuredOcr(structuredOcr) {
    return this.postWithRetry(this.endpoints.normalize, { structuredOcr });
  }

  async summarizeStructuredDocument({
    structuredDocument,
    patientContext,
    medications = [],
    medicalEntities = [],
  }) {
    return this.postWithRetry(this.endpoints.summarize, {
      structuredDocument,
      patientContext,
      medications,
      medicalEntities,
    });
  }

  async embedText(text) {
    return this.postWithRetry(this.endpoints.embeddings, { text });
  }

  async extractGraphs(structuredDocument) {
    return this.postWithRetry(this.endpoints.graphs, { structuredDocument });
  }

  async runOcrFromBuffer({ buffer, filename, mimeType, mode = "concise" }) {
    const form = new FormData();
    form.append("file", buffer, { contentType: mimeType, filename });
    form.append("mode", mode);

    const response = await this.client.post(this.endpoints.runOcr, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: DEFAULT_TIMEOUT,
    });
    return response.data;
  }
}

module.exports = new AiServiceClient();
