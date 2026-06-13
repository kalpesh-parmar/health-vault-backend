const { env } = require("../../../configs/env");
const aiOcrService = require("./geminiOcrService");
const objectStorageService = require("../../objectStorageService");
const { OcrEmptyResultError, GeminiInvalidResponseError } = require("./ocrErrors");
const { validateDocument } = require("./documentValidation");
const { createTrace, ocrLogger } = require("./ocrLogger");

function evaluateQuality(result) {
  const textLen = String(result?.ocr_text || "").trim().length;
  const confidence = result?.metadata?.confidence;
  const nonEmpty = result?.metadata?.nonEmptyPages ?? 0;

  if (nonEmpty <= 0 || textLen < env.aiMinTextChars) {
    return { ok: false, reason: "empty" };
  }
  if (typeof confidence === "number" && confidence < env.aiMinConfidence) {
    return { ok: false, reason: "low_confidence", confidence };
  }
  return { ok: true };
}

class OcrOrchestratorService {
  async runFromStorage({ fileKey, mimeType, traceId }) {
    const trace = createTrace(traceId);
    const t0 = Date.now();
    ocrLogger.info(trace, "ocr_started", {
      fileKey,
      mimeType,
      storageProvider: env.storageProvider,
    });

    let buffer;
    try {
      buffer = await objectStorageService.getFileBuffer(fileKey);
    } catch (error) {
      ocrLogger.error(trace, "ocr_download_failed", { fileKey, error: error.message });
      throw new OcrEmptyResultError(
        "OCR stopped because the source file could not be read from configured storage",
        {
          fileKey,
          storageProvider: env.storageProvider,
          cause: error.message,
        },
      );
    }

    return this.runFromBuffer({
      buffer,
      filename: fileKey,
      mimeType,
      traceId: trace,
      startedAt: t0,
    });
  }

  async runFromBuffer({ buffer, filename, mimeType, traceId, startedAt }) {
    const trace = createTrace(traceId);
    const t0 = startedAt || Date.now();
    ocrLogger.info(trace, "ocr_started", {
      filename,
      mimeType,
      bytes: buffer?.length,
      source: "buffer",
    });

    const { mimeType: resolvedMime } = validateDocument({ buffer, filename, mimeType });

    if (!aiOcrService.isConfigured) {
      throw new OcrEmptyResultError("OCR model is not configured", {
        filename,
        required: ["AI_MODEL", "AI_BASE_URL"],
      });
    }

    let result;
    try {
      result = await aiOcrService.extract({
        buffer,
        filename,
        mimeType: resolvedMime,
        traceId: trace,
      });
    } catch (error) {
      ocrLogger.error(trace, "ocr_model_failed", {
        model: env.aiModel,
        error: error.message,
        code: error.code || error.errorCode,
        rawSnippet: error.details?.rawSnippet,
        parseError: error.details?.parseError,
        validationErrors: error.details?.validationErrors,
        stack: error.stack,
      });

      // GeminiInvalidResponseError already carries rich diagnostics.
      if (error instanceof GeminiInvalidResponseError) {
        throw error;
      }

      throw new OcrEmptyResultError("OCR model failed and processing was stopped", {
        filename,
        model: env.aiModel,
        cause: error.message,
        code: error.code || error.errorCode,
        stack: error.stack,
      });
    }

    const quality = evaluateQuality(result);
    if (!quality.ok) {
      ocrLogger.error(trace, "ocr_model_result_rejected", {
        model: env.aiModel,
        reason: quality.reason,
        confidence: quality.confidence,
      });
      throw new OcrEmptyResultError("OCR model returned an invalid or unusable response", {
        filename,
        model: env.aiModel,
        reason: quality.reason,
        confidence: quality.confidence,
      });
    }

    ocrLogger.info(trace, "ocr_completed", {
      engine: result.engine,
      ms: Date.now() - t0,
      source: "configured-model",
    });
    return this._tag(result, { trace });
  }

  _tag(result, { trace }) {
    result.metrics = result.metrics || {};
    result.metrics.trace_id = trace;
    result.metrics.primary_engine = result.engine;
    result.metrics.fallback_used = false;
    result.metrics.model = env.aiModel;
    return result;
  }
}

module.exports = new OcrOrchestratorService();
module.exports.evaluateQuality = evaluateQuality;
