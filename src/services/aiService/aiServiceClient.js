const FormData = require("form-data");
const axios = require("axios");

const { env } = require("../../configs/env");
const { InternalServerException } = require("../../exceptions/appError");

const DEFAULT_TIMEOUT = 120 * 1000;
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

class AiServiceClient {
  get baseUrl() {
    return env.aiServiceUrl;
  }

  async runOcrFromStorage({ bucket, fileKey, mimeType, mode = "concise" }) {
    console.log("running ocr from storage", bucket, fileKey, mimeType, mode);

    return postWithRetry(`${this.baseUrl}/v1/run-ocr`, {
      bucket,
      fileKey,
      mimeType,
      mode,
    });
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
    const form = new FormData();
    form.append("file", buffer, { contentType: mimeType, filename });
    form.append("mode", mode);

    const response = await axios.post(`${this.baseUrl}/v1/run-ocr`, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: DEFAULT_TIMEOUT,
    });
    return response.data;
  }
}

module.exports = new AiServiceClient();
