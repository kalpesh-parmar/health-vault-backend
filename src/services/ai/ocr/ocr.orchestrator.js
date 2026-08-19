const { env } = require("../../../configs/env");
const objectStorageService = require("../../objectStorage.service");
const { AppError, NonMedicalDocumentException } = require("../../../exceptions/appError");
const { OcrEmptyResultError, OcrInvalidResponseError } = require("./ocr.validator");
const { createTrace, ocrLogger } = require("./ocr.logger");
const { ocrService } = require("./ocr.service");

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

function emptyMedicalExtraction() {
  return {
    patientInfo: {},
    hospitalInfo: {},
    doctorInfo: {},
    diagnosis: [],
    medications: [],
    labResults: [],
    vitals: [],
    recommendations: [],
    summary: "",
  };
}

function buildLines(pageText) {
  return String(pageText || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((text) => ({ text, confidence: null }));
}

function buildParagraphs(pages) {
  const paragraphs = [];
  for (const page of pages) {
    page.lines.forEach((line, order) => {
      paragraphs.push({
        text: line.text,
        confidence: line.confidence ?? null,
        page: page.page,
        label: "line",
        order,
      });
    });
  }
  return paragraphs;
}

function buildOcrResult({
  pages,
  engine,
  medicalExtraction,
  filename,
  mimeType,
  pageCount,
  processedPageCount,
  metrics = {},
}) {
  const normalizedPages = (Array.isArray(pages) ? pages : []).map((page) => {
    const text = String(page.text || "").trim();
    return {
      page: page.page,
      text,
      confidence: page.confidence ?? null,
      lines: buildLines(text),
      elapsed_ms: page.elapsed_ms ?? 0,
    };
  });

  const nonEmptyPages = normalizedPages.filter((p) => p.text).length;
  const fullText = normalizedPages
    .map((p) => p.text)
    .filter(Boolean)
    .join("\n\n")
    .trim();

  const confidences = normalizedPages
    .map((p) => p.confidence)
    .filter((c) => typeof c === "number" && Number.isFinite(c));
  const meanConfidence = confidences.length
    ? Number((confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(4))
    : null;

  const resolvedPageCount = pageCount ?? normalizedPages.length;
  const resolvedProcessed = processedPageCount ?? normalizedPages.length;

  const structuredDocument = {
    pages: normalizedPages,
    text: fullText,
    fullText,
    confidence: meanConfidence,
    pageCount: resolvedPageCount,
    processedPageCount: resolvedProcessed,
    paragraphs: buildParagraphs(normalizedPages),
    medicalExtraction: medicalExtraction || emptyMedicalExtraction(),
  };

  const clientEngine = String(engine || "").split(":", 1)[0] || "unknown";

  return {
    success: true,
    engine,
    ocr: { pages: normalizedPages, text: fullText },
    structuredDocument,
    ocr_text: fullText,
    metadata: {
      pageCount: resolvedPageCount,
      processedPageCount: resolvedProcessed,
      confidence: meanConfidence,
      filename,
      mimeType,
      nonEmptyPages,
    },
    metrics: {
      engine,
      client_engine: clientEngine,
      used_ocr: true,
      used_ai_model: true,
      used_qwen_vl: false,
      used_direct_text: false,
      non_empty_pages: nonEmptyPages,
      page_count: resolvedPageCount,
      processed_page_count: resolvedProcessed,
      mean_confidence: meanConfidence,
      ...metrics,
    },
  };
}

class OcrOrchestrator {
  async runFromStorage({ bucket, fileKey, mimeType, traceId, enforceMedicalGate = true }) {
    const trace = createTrace(traceId);
    const t0 = Date.now();
    ocrLogger.info(trace, "ocr_started", {
      bucket,
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
      enforceMedicalGate,
    });
  }

  async runFromBuffer({
    buffer,
    filename,
    mimeType,
    traceId,
    startedAt,
    enforceMedicalGate = true,
  }) {
    const trace = createTrace(traceId);
    const t0 = startedAt || Date.now();
    ocrLogger.info(trace, "ocr_started", {
      filename,
      mimeType,
      bytes: buffer?.length,
      source: "buffer",
    });

    // const { mimeType: resolvedMime } = validateDocument({ buffer, filename, mimeType });

    let result;
    try {
      console.log("[OCR_DEBUG] ocrService:", ocrService);
      console.log("[OCR_DEBUG] Object.keys(ocrService):", Object.keys(ocrService || {}));
      console.log(
        "[OCR_DEBUG] typeof ocrService.extractMedicalData:",
        typeof ocrService?.extractMedicalData,
      );

      if (!ocrService || typeof ocrService.extractMedicalData !== "function") {
        const missingErr = new Error(
          `OCR Service mismatch: ocrService is ${typeof ocrService} and extractMedicalData is ${typeof ocrService?.extractMedicalData}. Verify service exports.`,
        );
        ocrLogger.error(trace, "ocr_service_mismatch", { error: missingErr.message });
        throw missingErr;
      }

      const jsonStr = await ocrService.extractMedicalData({
        buffer,
        filename,
        mimeType,
        traceId: trace,
        enforceMedicalGate,
      });
      const parsedOCR = JSON.parse(jsonStr);

      result = buildOcrResult({
        pages: parsedOCR.pages,
        engine: `ollama:${env.aiModel}`,
        medicalExtraction: parsedOCR.medicalExtraction,
        filename,
        mimeType,
      });
    } catch (error) {
      ocrLogger.error(trace, "ocr_model_failed", {
        model: env.aiModel,
        error: error.message,
        stack: error.stack,
      });

      if (
        error instanceof OcrInvalidResponseError ||
        error instanceof NonMedicalDocumentException ||
        error instanceof AppError
      ) {
        throw error;
      }

      throw new OcrEmptyResultError(
        error.message || "OCR model failed and processing was stopped",
        {
          filename,
          model: env.aiModel,
          cause: error.message,
          stack: error.stack,
        },
      );
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

    const durationMs = Date.now() - t0;
    ocrLogger.info(trace, "ocr_completed", {
      engine: result.engine,
      ms: durationMs,
      source: "configured-model",
    });
    result.metrics = result.metrics || {};
    result.metrics.processing_seconds = Number((durationMs / 1000).toFixed(2));
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

const ocrOrchestrator = new OcrOrchestrator();

module.exports = {
  OcrOrchestrator,
  ocrOrchestrator,
  evaluateQuality,
  buildOcrResult,
};
