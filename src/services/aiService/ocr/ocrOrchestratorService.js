const { env } = require("../../../configs/env");
const objectStorageService = require("../../objectStorageService");
const { OcrEmptyResultError, OcrInvalidResponseError } = require("./ocrErrors");
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

    let result;
    try {
      const { qwenVisionService } = require("../../ai/qwenVisionService.ts");
      const { buildOcrResult } = require("./ocrResultBuilder");

      const jsonStr = await qwenVisionService.extractMedicalData({
        buffer,
        filename,
        mimeType: resolvedMime,
        traceId: trace,
      });
      const parsedOCR = JSON.parse(jsonStr);

      result = buildOcrResult({
        pages: parsedOCR.pages,
        engine: `ollama:qwen3-vl`,
        medicalExtraction: parsedOCR.medicalExtraction,
        filename,
        mimeType: resolvedMime,
      });
    } catch (error) {
      ocrLogger.error(trace, "ocr_model_failed", {
        model: "qwen3-vl:latest",
        error: error.message,
        stack: error.stack,
      });

      if (error instanceof OcrInvalidResponseError) {
        throw error;
      }

      throw new OcrEmptyResultError("OCR model failed and processing was stopped", {
        filename,
        model: "qwen3-vl:latest",
        cause: error.message,
        stack: error.stack,
      });
    }

    const quality = evaluateQuality(result);
    if (!quality.ok) {
      ocrLogger.error(trace, "ocr_model_result_rejected", {
        model: "qwen3-vl:latest",
        reason: quality.reason,
        confidence: quality.confidence,
      });
      throw new OcrEmptyResultError("OCR model returned an invalid or unusable response", {
        filename,
        model: "qwen3-vl:latest",
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
