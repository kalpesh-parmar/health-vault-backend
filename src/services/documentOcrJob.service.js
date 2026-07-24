/**
 * Non-blocking PDF extraction job orchestrator.
 *
 *  ┌────────────┐       enqueue        ┌──────────────────┐
 *  │ Controller │ ───────────────────► │ jobs table       │
 *  └─────┬──────┘                      │ (status=QUEUED)  │
 *        │ returns 202 immediately     └────────┬─────────┘
 *        │                                      │
 *        │ setImmediate(_runPipeline)           │
 *        ▼                                      ▼
 *  ┌────────────┐       update progress + emit SSE
 *  │  Pipeline  │ ──────────────────────────────►
 *  └─────┬──────┘
 *        │ on completion / failure: persist final payload
 *        ▼
 *   GET /run-ocr-status/:fileKey returns the row
 *
 * Why this works with an in-process job runner
 * ─────────────────────────────
 *  • The pipeline is a single chain of awaits. Failures are caught and
 *    persisted; nothing throws into Express's request lifecycle because
 *    the request has already returned 202.
 *  • Progress is dual-written to (a) the SSE bus for live FE updates and
 *    (b) the jobs table for crash recovery / late subscribers.
 *  • A weak-ref lock on the fileKey prevents duplicate concurrent runs
 *    for the same file inside a single Node process.
 *  • The jobs table is the source of truth; SSE is best-effort.
 *
 * For multi-instance deployments behind a load balancer use sticky
 * sessions OR replace `ocrProgressBus` with a PG LISTEN/NOTIFY adapter
 * (the public API of the bus is identical).
 */

const { env } = require("../configs/env");
const { STAGES, buildStageEvent } = require("../constants/ocrStages");
const { messageConstants } = require("../constants/messageConstants");
const { InvalidRequestException, NotFoundException } = require("../exceptions/appError");
const { aiClient: aiServiceClient, ocrOrchestrator, ocrService } = require("./ai");
const documentProcessingJobRepository = require("../repositories/documentProcessingJobRepository");
const DocumentIntelligenceRepository = require("../repositories/documentIntelligenceRepository");
const userOnboardingRepository = require("../repositories/userOnboardingRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const objectStorageService = require("./objectStorage.service");
const ocrProgressBus = require("./sse/ocrProgressBus");

const RUNNING_LOCKS = new Set();
const MIME_BY_EXTENSION = new Map([
  [".pdf", "application/pdf"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".webp", "image/webp"],
]);

function inferMimeType(fileKey, explicitMimeType) {
  if (explicitMimeType) return explicitMimeType;
  const cleanKey = String(fileKey || "")
    .split("?")[0]
    .toLowerCase();
  const dot = cleanKey.lastIndexOf(".");
  if (dot >= 0) {
    return MIME_BY_EXTENSION.get(cleanKey.slice(dot)) || "application/pdf";
  }
  return "application/pdf";
}

async function ensureFileExists(fileKey) {
  try {
    await objectStorageService.getSignedFileUrl(fileKey);
  } catch {
    throw new NotFoundException(`File not found in storage: ${fileKey}`);
  }
}

async function emitAndPersist(jobId, fileKey, stage, payload = {}) {
  const event = buildStageEvent(stage, payload);
  ocrProgressBus.publish(fileKey, event);
  await documentProcessingJobRepository
    .updateProgress(jobId, {
      completedSteps: event.completedSteps ?? 0,
      currentStep: event.currentStep,
      message: event.message ?? null,
      metadata: event.metadata ?? {},
      pendingSteps: event.pendingSteps ?? 0,
      percentage: event.percentage,
      stage: event.stage,
    })
    .catch((error) => {
      // Persistence failure must never abort the pipeline; log only.
      console.warn("[ocr-job] progress write failed", { error: error.message, fileKey, jobId });
    });
}

class DocumentOcrJobService {
  /**
   * Schedule an OCR + AI extraction run for a previously uploaded file.
   *
   * Returns the job row immediately. The actual pipeline runs in the
   * background via `setImmediate` so the HTTP request can resolve in
   * tens of milliseconds.
   */
  async enqueue({ fileKey, mimeType, userId }) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED || "fileKey is required");
    }

    await ensureFileExists(fileKey);

    const job = await documentProcessingJobRepository.startJob({ fileKey, userId });

    // Capture patient context once outside the pipeline to keep its body
    // free of repository fetches that should not block the worker chain.
    let patientContext = null;
    try {
      patientContext = await intelligenceRepository.getPatientContext(userId);
    } catch {
      patientContext = null;
    }

    // Schedule the pipeline. We deliberately do NOT await it. Errors are
    // captured inside `_runPipeline` and persisted to the job row.
    setImmediate(() => {
      this._runPipeline({ fileKey, jobId: job.id, mimeType, patientContext, userId }).catch(
        (error) => {
          // _runPipeline already handles its own failures; this catch is a
          // last-resort guard against bugs in the error path itself.
          console.error("[ocr-job] uncaught pipeline error", {
            error: error.message,
            fileKey,
            jobId: job.id,
          });
        },
      );
    });

    return job;
  }

  async getStatus({ fileKey, userId }) {
    return documentProcessingJobRepository.findByFileKey(fileKey, userId);
  }

  async _runPipeline({ fileKey, jobId, patientContext, userId, mimeType }) {
    if (RUNNING_LOCKS.has(fileKey)) {
      // Idempotency: a second enqueue while the first is in-flight is a
      // no-op. The shared job row already reflects the latest state.
      return;
    }
    RUNNING_LOCKS.add(fileKey);

    try {
      //print timing in teminal or console for each steps
      const startTime = Date.now();

      console.log(`[ocr-job] OCR job started at ${new Date(startTime).toISOString()}`);
      await documentProcessingJobRepository.markRunning(jobId);
      await emitAndPersist(jobId, fileKey, STAGES.OCR_STARTED, { metadata: { fileKey } });
      console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);
      // 1. Uploading File / Download check stage
      await emitAndPersist(jobId, fileKey, STAGES.UPLOADING_FILE);
      await ensureFileExists(fileKey);
      console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);

      // 2. Medical Document Validation stage
      await emitAndPersist(jobId, fileKey, STAGES.VALIDATING);
      console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);

      // 3. Extracting Text stage
      await emitAndPersist(jobId, fileKey, STAGES.EXTRACTING);
      console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);
      const ocrResponse = await ocrOrchestrator.runFromStorage({
        bucket: env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName,
        fileKey,
        mimeType: inferMimeType(fileKey, mimeType),
        traceId: `ocr_job_${jobId}`,
      });
      console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);
      const ocrPayload = ocrResponse?.structuredDocument || ocrResponse?.ocr || ocrResponse || {};
      const pageCount =
        ocrPayload?.pageCount ||
        ocrResponse?.metadata?.pageCount ||
        (Array.isArray(ocrPayload?.pages) ? ocrPayload.pages.length : 0);
      console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);

      // 4. Analyzing Report stage
      await emitAndPersist(jobId, fileKey, STAGES.ANALYZING, {
        metadata: {
          confidence: ocrResponse?.metadata?.confidence ?? null,
          pageCount,
          processingSeconds: ocrResponse?.metrics?.processing_seconds ?? null,
          usedDirectText: !!ocrResponse?.metrics?.used_direct_text,
          usedOcr: !!ocrResponse?.metrics?.used_ocr,
          engine: ocrResponse?.metrics?.engine ?? ocrResponse?.engine ?? null,
          primaryEngine: ocrResponse?.metrics?.primary_engine ?? null,
          fallbackUsed: false,
        },
      });
      console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);

      // 5. Generating Summary stage
      await emitAndPersist(jobId, fileKey, STAGES.SUMMARIZING);
      console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);
      const { rawOcrData, structured, normalized, summary } = await ocrService.normalizeExtraction({
        patientContext,
        rawOcr: ocrResponse,
      });

      let preferredLanguage = "gujarati";
      try {
        if (userId) {
          const onboardingRecord = await userOnboardingRepository.findByUserId(userId);
          if (onboardingRecord?.data?.preferredLanguage) {
            preferredLanguage = onboardingRecord.data.preferredLanguage;
          }
        }
      } catch (err) {
        console.warn("[ocr-job] failed to fetch preferred language", err);
      }

      let summaryEnglish = "";
      let summaryPreferredLanguage = "";
      const rawTextToSummarize = rawOcrData.fullText || "";
      if (rawTextToSummarize) {
        if (!preferredLanguage || preferredLanguage.toLowerCase() === "english") {
          summaryEnglish = await ocrService.generateSummary(rawTextToSummarize, "english");
          summaryPreferredLanguage = summaryEnglish;
        } else {
          const [sumEng, sumPref] = await Promise.all([
            ocrService.generateSummary(rawTextToSummarize, "english"),
            ocrService.generateSummary(rawTextToSummarize, preferredLanguage),
          ]);
          summaryEnglish = sumEng;
          summaryPreferredLanguage = sumPref;
        }
      }

      structured.summaryEnglish = summaryEnglish;
      structured.summaryInPreferredLanguage = summaryPreferredLanguage;

      // Best-effort graph extraction
      let graphs = [];
      try {
        graphs = await aiServiceClient.extractGraphs(normalized);
      } catch (error) {
        console.warn("[ocr-job] graph extraction failed", { error: error.message, fileKey, jobId });
      }

      const finalPayload = {
        embeddingsGenerated: false,
        extractedStructuredData: { ...structured, normalized, rawSummary: summary },
        fileKey,
        graphsDetected: graphs,
        metrics: rawOcrData.metrics,
        rawOcrData,
      };
      await documentProcessingJobRepository.markCompleted(jobId, {
        completedSteps: 8,
        currentStep: "Done",
        extractedStructuredData: finalPayload.extractedStructuredData,
        graphs,
        message: null,
        metadata: {
          confidence: rawOcrData.confidence,
          graphsDetected: graphs.length,
          medications: structured.medications.length,
          pageCount: rawOcrData.pageCount,
          processingSeconds: rawOcrData.processingSeconds,
        },
        pendingSteps: 0,
        rawOcrData,
      });

      ocrProgressBus.publish(
        fileKey,
        buildStageEvent(STAGES.COMPLETED, {
          metadata: {
            confidence: rawOcrData.confidence,
            graphsDetected: graphs.length,
            medications: structured.medications.length,
            pageCount: rawOcrData.pageCount,
            processingSeconds: rawOcrData.processingSeconds,
          },
        }),
      );
      ocrProgressBus.complete(fileKey);
    } catch (error) {
      await documentProcessingJobRepository.markFailed(jobId, error).catch(() => {});
      ocrProgressBus.fail(fileKey, error);
      console.error("[ocr-job] pipeline failed", { error: error.message, fileKey, jobId, userId });
    } finally {
      RUNNING_LOCKS.delete(fileKey);
    }
  }
}

module.exports = new DocumentOcrJobService();
