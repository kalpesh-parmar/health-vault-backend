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
const {
  ConflictException,
  InvalidRequestException,
  NotFoundException,
} = require("../exceptions/appError");
const { ocrStatus } = require("../enums/ocrStatus");
const { normalizeDocumentType } = require("../enums/documentType");
const { ocrOrchestrator, ocrService, embeddingService } = require("./ai");
const documentProcessingJobRepository = require("../repositories/documentProcessingJobRepository");
const documentRepository = require("../repositories/documentRepository");
const DocumentIntelligenceRepository = require("../repositories/documentIntelligenceRepository");
const userOnboardingRepository = require("../repositories/userOnboardingRepository");
const intelligenceRepository = new DocumentIntelligenceRepository();
const objectStorageService = require("./objectStorage.service");
const ocrProgressBus = require("./sse/ocrProgressBus");
const { inferMimeType } = require("../helpers/document.helper");

const RUNNING_LOCKS = new Set();

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
      // eslint-disable-next-line no-console
      console.warn("[ocr-job] progress write failed", { error: error.message, fileKey, jobId });
    });
}

class DocumentOcrJobService {
  async createQueuedJob({ fileKey, userId, mimeType, originalName }, tx = null) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_IS_REQUIRED || "fileKey is required");
    }
    return documentProcessingJobRepository.createQueuedJob(
      { fileKey, userId, mimeType, originalName },
      tx,
    );
  }

  async startJobById(jobId, userId) {
    if (!jobId) {
      throw new InvalidRequestException("jobId is required");
    }

    const claimedJob = await documentProcessingJobRepository.claimQueuedJob(jobId, userId);
    if (claimedJob) {
      const mimeType = claimedJob.metadata?.mimeType || null;

      let patientContext = null;
      try {
        patientContext = await intelligenceRepository.getPatientContext(userId);
      } catch {
        patientContext = null;
      }

      setImmediate(() => {
        this._runPipeline({
          fileKey: claimedJob.fileKey,
          jobId: claimedJob.id,
          mimeType,
          patientContext,
          userId,
        }).catch((error) => {
          // eslint-disable-next-line no-console
          console.error("[ocr-job] uncaught pipeline error", {
            error: error.message,
            fileKey: claimedJob.fileKey,
            jobId: claimedJob.id,
          });
        });
      });

      return claimedJob;
    }

    const existingJob = await documentProcessingJobRepository.findByIdAndUserId(jobId, userId);
    if (!existingJob) {
      throw new NotFoundException("OCR job not found");
    }

    throw new InvalidRequestException(
      `Job cannot be started because its current status is '${existingJob.status}'. Only QUEUED jobs can be started.`,
    );
  }

  async getJobById(jobId, userId) {
    if (!jobId) {
      throw new InvalidRequestException("jobId is required");
    }
    const job = await documentProcessingJobRepository.findByIdAndUserId(jobId, userId);
    if (!job) {
      throw new NotFoundException("OCR job not found");
    }
    return job;
  }

  async getJobResult(jobId, userId) {
    if (!jobId) {
      throw new InvalidRequestException("jobId is required");
    }

    const job = await documentProcessingJobRepository.findByIdAndUserId(jobId, userId);
    if (!job) {
      throw new NotFoundException("OCR job not found");
    }

    if (job.status === "FAILED") {
      throw new InvalidRequestException(`OCR job failed: ${job.error || "Unknown error"}`);
    }

    if (job.status === "CANCELLED") {
      throw new InvalidRequestException("OCR job was cancelled.");
    }

    if (job.status !== "COMPLETED") {
      throw new ConflictException(`OCR job result is not ready. Current status: ${job.status}`);
    }

    return {
      jobId: job.id,
      fileKey: job.fileKey,
      status: job.status,
      extractedStructuredData: job.extractedStructuredData,
      summaries: {
        summaryEnglish: job.extractedStructuredData?.summaryEnglish || "",
        summaryInPreferredLanguage: job.extractedStructuredData?.summaryInPreferredLanguage || "",
      },
      graphs: job.graphs || [],
    };
  }

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

    const job = await documentProcessingJobRepository.startJob({ fileKey, userId, mimeType });

    let patientContext = null;
    try {
      patientContext = await intelligenceRepository.getPatientContext(userId);
    } catch {
      patientContext = null;
    }

    setImmediate(() => {
      this._runPipeline({ fileKey, jobId: job.id, mimeType, patientContext, userId }).catch(
        (error) => {
          // eslint-disable-next-line no-console
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
      // eslint-disable-next-line no-console
      console.time("[OCR]: starting process");

      // console.log(`[ocr-job] OCR job started at ${new Date(startTime).toISOString()}`);
      await documentProcessingJobRepository.markRunning(jobId);
      await emitAndPersist(jobId, fileKey, STAGES.OCR_STARTED, { metadata: { fileKey } });

      // console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);
      // 1. Uploading File / Download check stage
      await emitAndPersist(jobId, fileKey, STAGES.UPLOADING_FILE);
      await ensureFileExists(fileKey);

      // console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);

      // 2. Medical Document Validation stage
      await emitAndPersist(jobId, fileKey, STAGES.VALIDATING);

      // console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);

      // 3. Extracting Text stage
      await emitAndPersist(jobId, fileKey, STAGES.EXTRACTING);

      // console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);
      const ocrResponse = await ocrOrchestrator.runFromStorage({
        bucket: env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName,
        fileKey,
        mimeType: inferMimeType(fileKey, mimeType),
        traceId: `ocr_job_${jobId}`,
      });

      // console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);
      const ocrPayload = ocrResponse?.structuredDocument || ocrResponse?.ocr || ocrResponse || {};
      const pageCount =
        ocrPayload?.pageCount ||
        ocrResponse?.metadata?.pageCount ||
        (Array.isArray(ocrPayload?.pages) ? ocrPayload.pages.length : 0);

      // console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);
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

      // console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);

      // 5. Generating Summary stage
      await emitAndPersist(jobId, fileKey, STAGES.SUMMARIZING);

      // console.log(`[ocr-job] OCR job started at ${new Date().toISOString()}`);
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
        // eslint-disable-next-line no-console
        console.warn("[ocr-job] failed to fetch preferred language", err);
      }

      const rawTextToSummarize = rawOcrData.fullText || "";
      let summaryEnglish =
        ocrResponse?.summaryEnglish ||
        structured?.summaryEnglish ||
        structured?.medicalExtraction?.summary ||
        structured?.summary ||
        "";
      let summaryPreferredLanguage =
        ocrResponse?.summaryGujarati || structured?.summaryInPreferredLanguage || "";

      if (rawTextToSummarize && (!summaryEnglish || !summaryPreferredLanguage)) {
        if (!preferredLanguage || preferredLanguage.toLowerCase() === "english") {
          if (!summaryEnglish) {
            summaryEnglish = await ocrService.generateSummary(rawTextToSummarize, "english");
          } else {
            // eslint-disable-next-line no-console
            console.log(
              "[OCR] => Reusing structured extraction summary for English (0ms extra latency)",
            );
          }
          summaryPreferredLanguage = summaryEnglish;
        } else {
          if (!summaryEnglish && !summaryPreferredLanguage) {
            const [sumEng, sumPref] = await Promise.all([
              ocrService.generateSummary(rawTextToSummarize, "english"),
              ocrService.generateSummary(rawTextToSummarize, preferredLanguage),
            ]);
            summaryEnglish = sumEng;
            summaryPreferredLanguage = sumPref;
          } else if (!summaryPreferredLanguage) {
            summaryPreferredLanguage = await ocrService.generateSummary(
              rawTextToSummarize,
              preferredLanguage,
            );
            // eslint-disable-next-line no-console
            console.log("[SC]>>>> pref summary", summaryPreferredLanguage);
            // eslint-disable-next-line no-console
            console.log("[SC]>>>>>language", preferredLanguage);
          }
        }
      }

      structured.documentType = ocrResponse?.documentType || structured?.documentType;
      structured.summaryEnglish = summaryEnglish;
      structured.summaryInPreferredLanguage = summaryPreferredLanguage;

      // Best-effort graph extraction
      let graphs = [];
      try {
        // graphs = await aiServiceClient.extractGraphs(normalized);
      } catch (error) {
        // eslint-disable-next-line no-console
        console.warn("[ocr-job] graph extraction failed", { error: error.message, fileKey, jobId });
      }

      const finalPayload = {
        embeddingsGenerated: true,
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
      const analyzedDocumentType = normalizeDocumentType(
        ocrResponse?.documentType || structured?.documentType || structured?.reportType,
      );
      // eslint-disable-next-line no-console
      console.time("[OCR]: updateOcrStatusByFileKey");
      const updatedDoc = await documentRepository
        .updateOcrStatusByFileKey(fileKey, ocrStatus.COMPLETED, {
          documentType: analyzedDocumentType,
          summaryEnglish,
          summaryInPreferredLanguage: summaryPreferredLanguage,
          structuredExtractedData: finalPayload.extractedStructuredData,
        })
        .catch((err) => {
          // eslint-disable-next-line no-console
          console.warn("[ocr-job] sync to documents.ocrStatus failed", {
            error: err.message,
            fileKey,
          });
          return null;
        });
      // eslint-disable-next-line no-console
      console.timeEnd("[OCR]: updateOcrStatusByFileKey");
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
      // eslint-disable-next-line no-console
      console.timeEnd("[OCR]: starting process");

      // Non-blocking fire-and-forget background embedding pipeline
      setImmediate(async () => {
        try {
          const docId = updatedDoc?.id;
          if (docId) {
            await embeddingService.embedAndPersist({
              documentId: docId,
              userId,
              rawOcr: {
                fullText: rawTextToSummarize || "",
                language: "en",
              },
              structured: {
                summary: summaryEnglish || summaryPreferredLanguage || "",
                observations: Array.isArray(structured?.diagnosis) ? structured.diagnosis : [],
                medications: structured?.medications || [],
                labResults: structured?.labResults || [],
              },
            });
            // eslint-disable-next-line no-console
            console.log(`[ocr-job] Chunks & embeddings persisted in background for docId ${docId}`);
          }
        } catch (embedErr) {
          // eslint-disable-next-line no-console
          console.warn(
            `[ocr-job] Background embedding generation failed for ${fileKey}:`,
            embedErr.message,
          );
        }
      });
    } catch (error) {
      await documentProcessingJobRepository.markFailed(jobId, error).catch(() => {});
      await documentRepository.updateOcrStatusByFileKey(fileKey, ocrStatus.FAILED).catch((err) => {
        // eslint-disable-next-line no-console
        console.warn("[ocr-job] sync to documents.ocrStatus failed", {
          error: err.message,
          fileKey,
        });
      });
      ocrProgressBus.fail(fileKey, error);
      // eslint-disable-next-line no-console
      console.error("[ocr-job] pipeline failed", { error: error.message, fileKey, jobId, userId });
    } finally {
      RUNNING_LOCKS.delete(fileKey);
    }
  }
}

module.exports = new DocumentOcrJobService();
