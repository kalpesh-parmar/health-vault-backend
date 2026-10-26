const fs = require("fs");
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

  async postWithRetry(
    endpoint,
    body,
    { headers, timeout = DEFAULT_TIMEOUT, retries = 1, ...restOptions } = {},
  ) {
    let lastError;
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await this.client.post(endpoint, body, {
          headers,
          timeout,
          ...restOptions,
        });
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
      { timeout: 120000, retries: 0 },
    );
  }

  async checkTranslationHealth() {
    try {
      const response = await this.client.get(this.endpoints.translate + "/health", {
        timeout: 3000,
      });
      return response.data;
    } catch {
      return { is_warm: false, status: "unavailable" };
    }
  }

  async detectLanguage({ text }) {
    return this.postWithRetry(
      this.endpoints.detectLanguage,
      { text },
      { timeout: 10000, retries: 1 },
    );
  }

  async validateMedicalDocument({ file, fileName, mimeType, maxPages, timeout }) {
    const tFormBuildStart = Date.now();
    const formData = new FormData();

    let filePayload = file;
    if (typeof file === "string" && fs.existsSync(file)) {
      filePayload = fs.createReadStream(file);
    } else if (file && file.path && fs.existsSync(file.path)) {
      filePayload = fs.createReadStream(file.path);
    } else if (file && file.buffer) {
      filePayload = file.buffer;
    }

    formData.append("file", filePayload, {
      filename: fileName || (typeof file === "object" ? file.originalname : "document"),
      contentType: mimeType || (typeof file === "object" ? file.mimetype : "application/pdf"),
    });

    if (maxPages) {
      formData.append("maxPages", String(maxPages));
    }

    const tFormBuildMs = Date.now() - tFormBuildStart;
    const effectiveTimeout = timeout || env.validationTimeoutMs || env.medgemmaTimeoutMs;

    let tUploadDone = null;
    let tFirstChunk = null;
    let tParseStart = null;
    let tParseEnd = null;

    const tSendStart = Date.now();
    console.log(
      `      [NODE TIMING] [HTTP -> Python POST ${this.endpoints.validateMedical}] START (FormData build: ${tFormBuildMs}ms)`,
    );

    const valRes = await this.postWithRetry(this.endpoints.validateMedical, formData, {
      timeout: effectiveTimeout,
      retries: 1,
      headers: formData.getHeaders(),
      onUploadProgress: (progress) => {
        if (!tUploadDone && progress.loaded >= (progress.total || progress.loaded)) {
          tUploadDone = Date.now();
        }
      },
      transformResponse: [
        (data) => {
          tFirstChunk = Date.now();
          tParseStart = Date.now();
          let parsed = data;
          try {
            parsed = JSON.parse(data);
          } catch {
            // Keep raw data if not JSON
          }
          tParseEnd = Date.now();
          return parsed;
        },
      ],
    });

    const tEnd = Date.now();
    const totalHttp = tEnd - tSendStart;
    const uploadDuration = tUploadDone ? tUploadDone - tSendStart : 0;
    const serverProcessing =
      tFirstChunk && tUploadDone
        ? tFirstChunk - tUploadDone
        : tFirstChunk
          ? tFirstChunk - tSendStart
          : totalHttp;
    const responseRead = tParseEnd && tParseStart ? tParseEnd - tParseStart : 0;

    console.log(
      `      [NODE TIMING] [HTTP -> Python POST ${this.endpoints.validateMedical}] BREAKDOWN: ` +
        `FormData Build=${tFormBuildMs}ms | Request Send (Socket Upload)=${uploadDuration}ms | ` +
        `Server Wait=${serverProcessing}ms | Response Read=${responseRead}ms | Total HTTP=${totalHttp}ms`,
    );
    return valRes;
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

  async dispatchDocumentProcessing(payload) {
    const tPostDispatch = Date.now();
    console.log(
      `      [NODE TIMING] [HTTP -> Python POST ${this.endpoints.processDocument}] START`,
    );
    const dispatchRes = await this.postWithRetry(this.endpoints.processDocument, payload, {
      headers: {
        "X-Internal-Service-Key": env.internalServiceKey,
      },
      timeout: 15000,
      retries: 2,
    });
    console.log(
      `      [NODE TIMING] [HTTP -> Python POST ${this.endpoints.processDocument}] COMPLETED in ${Date.now() - tPostDispatch}ms`,
    );
    return dispatchRes;
  }
}

module.exports = new AiServiceClient();
