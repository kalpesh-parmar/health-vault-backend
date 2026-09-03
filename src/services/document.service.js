/**
 * Document CRUD service with Resumable and Retryable Pipeline Execution.
 */

const path = require("path");
const { StatusCodes } = require("http-status-codes");

const { errorConstants } = require("../constants/errorConstants");
const { messageConstants } = require("../constants/messageConstants");
const {
  AppError,
  NotFoundException,
  InvalidRequestException,
  NonMedicalDocumentException,
  FATAL_ERROR_CODES,
} = require("../exceptions/appError");
const documentRepository = require("../repositories/documentRepository");
const patientRepository = require("../repositories/patientRepository");
const chatSessionRepository = require("../repositories/chatSessionRepository");
const documentProcessingJobRepository = require("../repositories/documentProcessingJobRepository");
const objectStorageService = require("./objectStorage.service");
const {
  idParamSchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  listDocumentsQuerySchema,
  validateSchema,
} = require("../validations");
const { updateDocumentSchema } = require("../validations/documentValidation");
const sseConnectionService = require("./sseConnection.service");
const { newBatchId, newFileKey, normalizeFiles } = require("../utils/fileUtils");
const { OCR_CONCURRENCY, ALLOWED_MIME_TYPES } = require("../configs/fileConfig");
const { StageType } = require("../enums/stageStatus");
const { ProgressEmitter } = require("./progressEmitter.service");
const { DOCUMENT_STAGES, STAGE_WEIGHTS } = require("../constants/documentProgress.constants");
const { env } = require("../configs/env");
const { FileCategory } = require("../enums/fileCategory");
const aiServiceClient = require("../clients/aiServiceClient");
const { ocrOrchestrator, ocrService, embeddingService } = require("./ai");
const documentPersistenceService = require("./documentPersistence.service");
const aiClient = require("./ai/clients/aiClient.service");

const defaultProvider = ocrOrchestrator;
const documentStore = new Map();

function withTimeout(promise, ms, stageName) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new AppError(
        StatusCodes.GATEWAY_TIMEOUT,
        `Stage ${stageName} timed out after ${ms}ms`,
        "STAGE_TIMEOUT",
        true,
      );
      reject(err);
    }, ms);

    Promise.resolve(promise)
      .then((res) => {
        clearTimeout(timer);
        resolve(res);
      })
      .catch((err) => {
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function resolveRawOcrData(ctx) {
  if (ctx.rawOcrData) return ctx.rawOcrData;
  if (ctx.job?.rawOcrData) {
    ctx.rawOcrData = ctx.job.rawOcrData;
    return ctx.rawOcrData;
  }
  const ocrKey = ctx.checkpointData?.ocrArtifactKey || ctx.job?.checkpointData?.ocrArtifactKey;
  if (ocrKey) {
    const buffer = await objectStorageService.getFileBuffer(ocrKey);
    ctx.rawOcrData = JSON.parse(buffer.toString("utf-8"));
    return ctx.rawOcrData;
  }
  return null;
}

const STAGES_PIPELINE = [
  {
    stage: DOCUMENT_STAGES.VALIDATING,
    timeoutMs: env.stageTimeoutMs || 120000,
    message: messageConstants.VALIDATE_DOCUMENT_FORMAT,
    isSatisfied: (ctx) => Boolean(ctx.job?.checkpointData?.validation?.isMedical),
    run: async (ctx) => {
      const isMimeAllowed =
        ctx.record?.mimeType &&
        (ALLOWED_MIME_TYPES.PATIENT_DOCUMENT.has
          ? ALLOWED_MIME_TYPES.PATIENT_DOCUMENT.has(ctx.record.mimeType)
          : Array.from(ALLOWED_MIME_TYPES.PATIENT_DOCUMENT).includes(ctx.record.mimeType));

      if (!isMimeAllowed) {
        throw new AppError(
          StatusCodes.BAD_REQUEST,
          errorConstants.INVALID_DOCUMENT_TYPE,
          "INVALID_DOCUMENT_TYPE",
          false,
        );
      }

      const fileBuffer = ctx.file?.buffer;
      if (!fileBuffer) {
        throw new InvalidRequestException("File buffer required for validation stage");
      }

      ctx.emitter.stage(
        DOCUMENT_STAGES.VALIDATING,
        StageType.IN_PROGRESS,
        messageConstants.CHECK_DOCUMENT_IS_MEDICAL,
      );

      const validationResult = await aiServiceClient.validateMedicalDocument({
        file: fileBuffer,
        fileName: ctx.file?.originalname || ctx.record?.fileName,
        mimeType: ctx.file?.mimetype || ctx.record?.mimeType,
      });

      if (!validationResult || validationResult.isMedical !== true) {
        const failReason =
          validationResult?.reason || errorConstants.UPLOADED_FILE_NOT_A_VALID_MEDICAL_DOCUMENT;
        throw new NonMedicalDocumentException(failReason, validationResult);
      }

      ctx.checkpointData.validation = validationResult;
    },
  },
  {
    stage: DOCUMENT_STAGES.UPLOADING,
    timeoutMs: env.stageTimeoutMs || 120000,
    message: messageConstants.UPLOADING_DOCUMENT,
    isSatisfied: (ctx) =>
      Boolean(
        ctx.job?.checkpointData?.uploaded &&
        (ctx.job?.checkpointData?.s3Bucket || ctx.record?.bucket),
      ),
    run: async (ctx) => {
      if (!ctx.file?.buffer) {
        throw new InvalidRequestException(errorConstants.FILE_BUFFER_REQUIRED_FOR_UPLOADING_STAGE);
      }

      const uploadResult = await objectStorageService.uploadFile(
        ctx.file,
        FileCategory.DOCUMENT,
        ctx.patientId,
      );
      const fileKey = uploadResult?.fileKey || uploadResult?.s3Key || ctx.fileKey;
      const bucket =
        uploadResult?.s3Bucket ||
        uploadResult?.bucket ||
        (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName) ||
        env.patientDocumentsBucket;

      ctx.fileKey = fileKey;
      ctx.bucket = bucket;
      if (ctx.record) {
        ctx.record.fileKey = fileKey;
        ctx.record.bucket = bucket;
      }

      ctx.checkpointData.uploaded = true;
      ctx.checkpointData.s3Bucket = bucket;
    },
  },
  {
    stage: DOCUMENT_STAGES.OCR_RUNNING,
    timeoutMs: env.ocrStageTimeoutMs || 300000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) =>
      Boolean(ctx.rawOcrData || ctx.job?.rawOcrData || ctx.job?.checkpointData?.ocrArtifactKey),
    run: async (ctx) => {
      const ocrEngine = ctx.ocr || defaultProvider;
      const bucket = ctx.bucket || ctx.job?.checkpointData?.s3Bucket || env.patientDocumentsBucket;
      const ocrResponse = await ocrEngine.runFromStorage({
        bucket,
        fileKey: ctx.fileKey,
        mimeType: ctx.record?.mimeType,
        traceId: `ocr_job_${ctx.fileKey}`,
      });

      ctx.rawOcrData = ocrResponse;

      // Hybrid OCR Checkpointing
      const serialized = JSON.stringify(ocrResponse);
      const byteSize = Buffer.byteLength(serialized, "utf-8");
      if (byteSize <= (env.ocrInlineMaxBytes || 500 * 1024)) {
        ctx.patch.rawOcrData = ocrResponse;
      } else {
        const artifactKey = `${ctx.fileKey}.ocr.json`;
        await objectStorageService.uploadBuffer({
          body: Buffer.from(serialized, "utf-8"),
          contentType: "application/json",
          key: artifactKey,
        });
        ctx.checkpointData.ocrArtifactKey = artifactKey;
      }
    },
  },
  {
    stage: DOCUMENT_STAGES.PARSING,
    timeoutMs: 30000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) => ctx.completedStages.includes(DOCUMENT_STAGES.PARSING),
    run: async () => {},
  },
  {
    stage: DOCUMENT_STAGES.FIELD_EXTRACTION,
    timeoutMs: env.llmStageTimeoutMs || 180000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) => Boolean(ctx.structured || ctx.job?.extractedStructuredData),
    run: async (ctx) => {
      const rawOcr = await resolveRawOcrData(ctx);
      const normalizedData = await ocrService.normalizeExtraction({
        patientContext: ctx.record?.patientContext || null,
        rawOcr,
      });
      const { rawOcrData: updatedRawOcr, structured } = normalizedData || {};

      if (updatedRawOcr) {
        ctx.rawOcrData = updatedRawOcr;
      }
      ctx.structured = structured || {};
      ctx.patch.extractedStructuredData = ctx.structured;
    },
  },
  {
    stage: DOCUMENT_STAGES.ANALYZING,
    timeoutMs: 30000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) => ctx.completedStages.includes(DOCUMENT_STAGES.ANALYZING),
    run: async () => {},
  },
  {
    stage: DOCUMENT_STAGES.SUMMARIZING,
    timeoutMs: env.llmStageTimeoutMs || 180000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) =>
      Boolean(
        ctx.structured?.summaryEnglish ||
        ctx.structured?.summary ||
        ctx.checkpointData?.summaryEnglish,
      ),
    run: async (ctx) => {
      let summaryEnglish =
        ctx.structured?.summaryEnglish ||
        ctx.structured?.summary ||
        ctx.checkpointData?.summaryEnglish ||
        "";

      if (!summaryEnglish) {
        const rawOcr = await resolveRawOcrData(ctx);
        const rawTextToSummarize = rawOcr?.fullText || "";
        if (rawTextToSummarize) {
          try {
            summaryEnglish = await ocrService.generateSummary(rawTextToSummarize, "english");
            ctx.checkpointData.summaryEnglish = summaryEnglish;
            if (ctx.structured) {
              ctx.structured.summaryEnglish = summaryEnglish;
              ctx.patch.extractedStructuredData = ctx.structured;
            }
          } catch (sumErr) {
            console.warn("[runExtraction] summary fallback failed:", sumErr.message);
          }
        }
      }
    },
  },
  {
    stage: DOCUMENT_STAGES.GRAPH_EXTRACTION,
    timeoutMs: env.llmStageTimeoutMs || 180000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) =>
      Boolean(
        (ctx.graphs && ctx.graphs.length > 0) ||
        (ctx.job?.graphs && ctx.job.graphs.length > 0) ||
        ctx.completedStages.includes(DOCUMENT_STAGES.GRAPH_EXTRACTION),
      ),
    run: async (ctx) => {
      let graphs = [];
      if (ctx.structured) {
        try {
          graphs = await aiClient.extractGraphs(ctx.structured);
        } catch (graphErr) {
          console.warn("[runExtraction] graph extraction failed:", graphErr.message);
        }
      }
      ctx.graphs = graphs || [];
      ctx.patch.graphs = ctx.graphs;
    },
  },
  {
    stage: DOCUMENT_STAGES.PERSISTING,
    timeoutMs: env.stageTimeoutMs || 120000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) => Boolean(ctx.savedResult?.document?.id || ctx.checkpointData?.documentId),
    run: async (ctx) => {
      const rawOcr = await resolveRawOcrData(ctx);
      const bucket = ctx.bucket || ctx.job?.checkpointData?.s3Bucket || env.patientDocumentsBucket;

      const savedResult = await documentPersistenceService.addDocument({
        userId: ctx.patientId,
        payload: {
          s3Key: ctx.fileKey,
          s3bucket: bucket,
          fileName: ctx.record?.fileName || ctx.file?.originalname,
          fileType: ctx.record?.mimeType || ctx.file?.mimetype,
          fileSize: ctx.record?.sizeBytes || ctx.file?.size,
          rawOcrData: rawOcr,
          extractedStructuredData: ctx.structured,
          graphs: ctx.graphs || [],
          embeddingsGenerated: false,
          skipMedications: true,
        },
      });

      ctx.savedResult = savedResult;
      ctx.checkpointData.documentId = savedResult?.document?.id;
    },
  },
  {
    stage: DOCUMENT_STAGES.CHUNKING,
    timeoutMs: 30000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) => ctx.completedStages.includes(DOCUMENT_STAGES.CHUNKING),
    run: async () => {},
  },
  {
    stage: DOCUMENT_STAGES.EMBEDDING,
    timeoutMs: env.stageTimeoutMs || 120000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) => Boolean(ctx.checkpointData?.embeddingsGenerated),
    run: async (ctx) => {
      const docId = ctx.savedResult?.document?.id || ctx.checkpointData?.documentId;
      const rawOcr = await resolveRawOcrData(ctx);
      if (docId) {
        try {
          await embeddingService.embedAndPersist({
            documentId: docId,
            rawOcr,
            structured: ctx.structured,
            userId: ctx.patientId,
          });
          ctx.checkpointData.embeddingsGenerated = true;
        } catch (embedErr) {
          console.warn("[runExtraction] embedding persistence failed:", embedErr.message);
        }
      }
    },
  },
];

class DocumentService {
  constructor() {
    this._startWatchdog();
    this._reconcileRunningJobsOnBoot();
  }

  _startWatchdog(intervalMs = 30000) {
    const watchdogInterval = setInterval(async () => {
      try {
        const timeoutMs = env.stageTimeoutMs || 120000;
        const cutoff = new Date(Date.now() - timeoutMs);
        const stalledJobs = await documentProcessingJobRepository.findStalledRunningJobs(cutoff);
        for (const job of stalledJobs) {
          const failedStage = job.stage || DOCUMENT_STAGES.VALIDATING;
          const requiresReupload = [
            DOCUMENT_STAGES.QUEUED,
            DOCUMENT_STAGES.VALIDATING,
            DOCUMENT_STAGES.UPLOADING,
          ].includes(failedStage);

          await documentProcessingJobRepository.checkpointStage(job.id, {
            status: "FAILED",
            stageStatus: StageType.FAILED,
            retryable: true,
            requiresReupload,
            error: "Stage stalled without progress",
            lastHeartbeatAt: new Date(),
          });

          const emitter = ProgressEmitter.for({
            fileKey: job.fileKey,
            fileName: job.metadata?.originalName || "document",
            batchId: job.metadata?.batchId,
            patientId: job.userId,
          });

          emitter.error(failedStage, "Stage stalled without progress", {
            errorCode: "STAGE_STALLED",
            retryable: true,
            requiresReupload,
            failedStage,
            resumeStage: failedStage,
          });
        }
      } catch (err) {
        console.warn("[Watchdog] sweep error:", err.message);
      }
    }, intervalMs);

    if (watchdogInterval && watchdogInterval.unref) {
      watchdogInterval.unref();
    }
  }

  async _reconcileRunningJobsOnBoot() {
    try {
      const recovered = await documentProcessingJobRepository.reconcileRunningJobsOnBoot();
      if (recovered && recovered.length > 0) {
        console.log(
          `[BootReconciliation] Recovered ${recovered.length} orphaned RUNNING jobs to FAILED/retryable.`,
        );
      }
    } catch (err) {
      console.warn("[BootReconciliation] startup reconciliation failed:", err.message);
    }
  }

  async getDocumentById(id, userId) {
    const params = await validateSchema(idParamSchema, { id });
    const existingDocument = await documentRepository.findById(params.id);

    if (!existingDocument || existingDocument.userId !== userId) {
      throw new NotFoundException(errorConstants.DOCUMENT_NOT_FOUND);
    }
    return existingDocument;
  }

  async getDocumentList(userId, payload) {
    const filters = await validateSchema(listDocumentsQuerySchema, payload);

    const { rows, total } = await documentRepository.findAll({
      ...filters,
      userId,
    });

    return {
      items: rows,
      limit: filters.limit,
      page: filters.page,
      total,
    };
  }

  async getDocumentSummaryList(userId, payload) {
    const filters = await validateSchema(listDocumentsQuerySchema, payload);

    const { rows, total } = await documentRepository.findAll({
      ...filters,
      userId,
    });

    const summaries = rows.map((doc) => ({
      id: doc.id,
      fileName: doc.fileName,
      documentType: doc.documentType,
      summaryEnglish: doc.summaryEnglish,
      summaryInPreferredLanguage: doc.summaryInPreferredLanguage,
      createdAt: doc.createdAt,
    }));

    return {
      items: summaries,
      limit: filters.limit,
      page: filters.page,
      total,
    };
  }

  async listDocuments(userId, payload) {
    const data = await validateSchema(listDocumentsFilterSortSchema, payload || {});
    return documentRepository.findAllByFilterAndSort({
      userId,
      ...data,
    });
  }

  async listDocumentsPaginated(userId, payload) {
    if (!userId) {
      throw new InvalidRequestException(errorConstants.USER_NOT_FOUND);
    }
    const data = await validateSchema(listDocumentsPaginatedSchema, payload);
    const result = await documentRepository.findAllByFilterSortAndPagination({
      ...data,
      userId,
    });
    return {
      items: result.data,
      page: result.page,
    };
  }

  async deleteDocument(id, userId) {
    const params = await validateSchema(idParamSchema, { id });
    const deletedDocument = await documentRepository.softDeleteById(params.id, userId);

    if (!deletedDocument) {
      throw new NotFoundException(errorConstants.DOCUMENT_NOT_FOUND);
    }

    // Also remove the document from any chat sessions where it's referenced
    await chatSessionRepository.removeDocumentFromSessions(params.id, userId);

    return deletedDocument;
  }

  async getDownloadUrl(fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }
    const url = await objectStorageService.getSignedFileUrl(fileKey);
    return { signedUrl: url };
  }

  async deleteFile(userId, fileKey) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }
    await objectStorageService.deleteFile(fileKey);
    await documentRepository.deleteByPatientId(userId);
    return { message: messageConstants.DOCUMENT_DELETED };
  }

  async updateDocument(id, payload, authUserId) {
    const params = await validateSchema(idParamSchema, { id });
    const existingDocument = await documentRepository.findById(params.id);
    if (!existingDocument || existingDocument.userId !== authUserId) {
      throw new NotFoundException(errorConstants.DOCUMENT_NOT_FOUND);
    }
    const data = await validateSchema(updateDocumentSchema, payload);

    const updateData = { ...data };
    if (updateData.originalName && !updateData.fileName) {
      updateData.fileName = updateData.originalName;
    }
    delete updateData.originalName;

    if (updateData.category && !updateData.documentType) {
      updateData.documentType = updateData.category;
    }
    delete updateData.category;

    if (updateData.fileName) {
      const existingExt = path.extname(existingDocument.fileName || "");
      if (existingExt) {
        const inputExt = path.extname(updateData.fileName);
        const baseName = inputExt
          ? path.basename(updateData.fileName, inputExt).trim()
          : updateData.fileName.trim();
        updateData.fileName = `${baseName}${existingExt}`;
      } else {
        updateData.fileName = updateData.fileName.trim();
      }
    }

    const updatedDocument = await documentRepository.update(params.id, updateData);
    return updatedDocument;
  }

  async uploadDocuments(files, authUserId, options = {}) {
    try {
      if (!authUserId) {
        throw new InvalidRequestException(errorConstants.UNAUTHORIZED_ACCESS_TO_PATIENT_RESOURCE);
      }

      const existingPatient = await patientRepository.findById(authUserId);
      if (!existingPatient) {
        throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
      }

      const list = normalizeFiles(files);
      if (!list || !Array.isArray(list) || list.length === 0) {
        throw new InvalidRequestException(errorConstants.AT_LEAST_ONE_DOCUMENT_FILE_IS_REQUIRED);
      }
      if (list?.length > 5) {
        throw new InvalidRequestException(errorConstants.MAXIMUM_FIVE_DOCUMENT_FILES_ALLOWED);
      }

      const patientId = authUserId;
      const opts = options || {};
      const batchId = newBatchId();
      const fileKeys = list.map(() => newFileKey());

      sseConnectionService.registerBatch(batchId, fileKeys);

      const jobs = await Promise.all(
        list.map(async (file, index) => {
          const fileKey = fileKeys[index];
          const jobRow = await documentProcessingJobRepository.createQueuedJob({
            fileKey,
            userId: authUserId,
            mimeType: file?.mimetype || "",
            originalName: file?.originalname || "",
          });

          const record = {
            jobId: jobRow?.id,
            fileKey,
            batchId,
            patientId,
            uploadedBy: authUserId,
            fileName: file?.originalname || "",
            mimeType: file?.mimetype || "",
            sizeBytes: file?.size || 0,
            status: StageType.QUEUED,
            createdAt: new Date().toISOString(),
            options: {
              documentType: opts?.documentType || null,
              language: opts?.language || "eng",
              returnRawText: opts?.returnRawText !== false,
            },
          };
          documentStore.set(record.fileKey, record);

          const emitter = ProgressEmitter.for({
            fileKey: record.fileKey,
            fileName: record.fileName,
            batchId,
            patientId,
          });

          emitter.stage(StageType.QUEUED, StageType.STARTED, messageConstants.QUEUE_FOR_EXTRACTION);

          return { file, record, emitter, job: jobRow };
        }),
      );

      setImmediate(() => {
        runWithConcurrency(jobs, OCR_CONCURRENCY).catch((err) =>
          console.error("[document.service] batch runner failed", err),
        );
      });

      return {
        batchId,
        patientId,
        total: jobs.length,
        batchUrl: `/sse/batches/${batchId}/stream`,
        documents: jobs.map(({ record, job }) => ({
          jobId: record.jobId || job?.id || null,
          fileKey: record.fileKey,
          fileName: record.fileName,
          status: record.status,
          streamUrl: `/sse/files/${record.fileKey}/stream`,
        })),
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error in file upload: ", error);
      throw error;
    }
  }

  async retryDocument({ fileKey, userId, file = null }) {
    if (!fileKey) {
      throw new InvalidRequestException(messageConstants.FILE_KEY_REQUIRED);
    }
    const job = await documentProcessingJobRepository.findByFileKey(fileKey, userId);
    if (!job) {
      throw new NotFoundException("Document job not found");
    }
    if (job.status === "REJECTED" || job.retryable === false) {
      throw new InvalidRequestException(
        "This document failed with a non-retryable error and cannot be retried.",
      );
    }
    if (job.attemptCount >= (env.documentMaxRetryAttempts || 3)) {
      throw new InvalidRequestException(
        `Maximum retry attempts (${env.documentMaxRetryAttempts || 3}) exceeded for this document.`,
      );
    }
    if (job.status === "RUNNING") {
      return {
        fileKey,
        status: "RUNNING",
        resumeStage: job.stage || DOCUMENT_STAGES.QUEUED,
        progress: job.percentage || 0,
        streamUrl: `/sse/files/${fileKey}/stream`,
      };
    }

    const requiresReupload =
      job.requiresReupload ||
      [DOCUMENT_STAGES.QUEUED, DOCUMENT_STAGES.VALIDATING, DOCUMENT_STAGES.UPLOADING].includes(
        job.stage,
      );

    if (requiresReupload && (!file || !file.buffer)) {
      throw new InvalidRequestException(
        "This stage failure requires re-uploading the file payload.",
      );
    }

    const claimed = await documentProcessingJobRepository.claimJobForRetry(fileKey, userId);
    if (!claimed) {
      return {
        fileKey,
        status: "RUNNING",
        resumeStage: job.stage || DOCUMENT_STAGES.QUEUED,
        progress: job.percentage || 0,
        streamUrl: `/sse/files/${fileKey}/stream`,
      };
    }

    sseConnectionService.reopen(fileKey);
    if (job.metadata?.batchId) {
      sseConnectionService.unmarkDocumentDone(job.metadata.batchId, fileKey);
    }

    const emitter = ProgressEmitter.for({
      fileKey,
      fileName: job.metadata?.originalName || file?.originalname || "document",
      batchId: job.metadata?.batchId,
      patientId: userId,
    });

    const record = {
      jobId: claimed.id,
      fileKey,
      batchId: job.metadata?.batchId,
      patientId: userId,
      uploadedBy: userId,
      fileName: job.metadata?.originalName || file?.originalname || "",
      mimeType: job.metadata?.mimeType || file?.mimetype || "application/pdf",
      sizeBytes: file?.size || 0,
      status: StageType.IN_PROGRESS,
      stage: claimed.stage,
      attemptCount: claimed.attemptCount,
    };
    documentStore.set(fileKey, record);

    const jobs = [
      {
        file: file || {
          originalname: record.fileName,
          mimetype: record.mimeType,
          buffer: null,
        },
        record,
        emitter,
        job: claimed,
      },
    ];

    setImmediate(() => {
      runWithConcurrency(jobs, OCR_CONCURRENCY).catch((err) =>
        console.error("[document.service] retry runner failed", err),
      );
    });

    const resumeStage = claimed.stage || DOCUMENT_STAGES.QUEUED;
    const progress = STAGE_WEIGHTS[resumeStage]?.[0] ?? claimed.percentage ?? 0;

    return {
      jobId: claimed.id,
      fileKey,
      status: "RUNNING",
      resumeStage,
      progress,
      streamUrl: `/sse/files/${fileKey}/stream`,
    };
  }
}

/** Bounded concurrency: a 50-file batch must not spawn 50 OCR workers. */
async function runWithConcurrency(jobs, limit) {
  const queue = [...jobs];
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      await processOne(queue.shift());
    }
  });
  await Promise.all(workers);
}

/** Run one document and fold the result back into the store. */
async function processOne({ file, record, emitter, job = null }) {
  record.status = StageType.IN_PROGRESS;
  documentStore.set(record.fileKey, record);

  const result = await runExtraction({ file, record, emitter, job });

  if (result) {
    Object.assign(record, result);
  } else {
    record.status = record.status || StageType.FAILED;
    record.errorCode = record?.errorCode || "PIPELINE_FAILED";
  }
  documentStore.set(record.fileKey, record);
  return result;
}

async function runExtraction({
  file,
  record,
  emitter,
  ocr = defaultProvider,
  job: initialJob = null,
}) {
  const startedAt = Date.now();
  let currentStage = record?.stage || DOCUMENT_STAGES.VALIDATING;
  let jobId = record?.jobId || initialJob?.id;

  const patientId = record?.patientId || record?.uploadedBy;
  const fileKey = record?.fileKey;

  // Hydrate or fetch job from DB if needed
  let job = initialJob;
  if (!job && fileKey && patientId) {
    job = await documentProcessingJobRepository.findByFileKey(fileKey, patientId).catch(() => null);
    if (job) jobId = job.id;
  }

  const checkpointData = { ...(job?.checkpointData || {}) };
  const completedStages = [...(job?.completedStages || [])];

  const ctx = {
    file,
    record,
    emitter,
    ocr: ocr || defaultProvider,
    job,
    jobId,
    patientId,
    fileKey,
    bucket: record?.bucket || job?.checkpointData?.s3Bucket || null,
    rawOcrData: job?.rawOcrData || null,
    structured: job?.extractedStructuredData || null,
    graphs: job?.graphs || [],
    savedResult: null,
    checkpointData,
    completedStages,
    patch: {},
  };

  try {
    for (const pipelineStep of STAGES_PIPELINE) {
      currentStage = pipelineStep.stage;
      record.stage = currentStage;
      ctx.patch = {};

      const [, maxWeight] = STAGE_WEIGHTS[currentStage] || [0, 100];
      const isDone = completedStages.includes(currentStage) || pipelineStep.isSatisfied(ctx);

      if (isDone) {
        if (!completedStages.includes(currentStage)) {
          completedStages.push(currentStage);
        }
        if (currentStage === DOCUMENT_STAGES.UPLOADING && !ctx.bucket) {
          ctx.bucket = ctx.job?.checkpointData?.s3Bucket || ctx.record?.bucket;
        }
        if (currentStage === DOCUMENT_STAGES.OCR_RUNNING && !ctx.rawOcrData) {
          ctx.rawOcrData = await resolveRawOcrData(ctx);
        }
        if (currentStage === DOCUMENT_STAGES.FIELD_EXTRACTION && !ctx.structured) {
          ctx.structured = ctx.job?.extractedStructuredData || null;
        }
        if (
          currentStage === DOCUMENT_STAGES.GRAPH_EXTRACTION &&
          (!ctx.graphs || ctx.graphs.length === 0)
        ) {
          ctx.graphs = ctx.job?.graphs || [];
        }
        emitter.stage(currentStage, StageType.IN_PROGRESS, pipelineStep.message, 1);
        continue;
      }

      emitter.stage(currentStage, StageType.STARTED, pipelineStep.message);

      await withTimeout(pipelineStep.run(ctx), pipelineStep.timeoutMs, currentStage);

      completedStages.push(currentStage);
      emitter.stage(currentStage, StageType.IN_PROGRESS, pipelineStep.message, 1);

      if (jobId) {
        await documentProcessingJobRepository
          .checkpointStage(jobId, {
            stage: currentStage,
            stageStatus: StageType.IN_PROGRESS,
            percentage: maxWeight,
            completedStages,
            checkpointData: ctx.checkpointData,
            ...(ctx.patch.rawOcrData !== undefined ? { rawOcrData: ctx.patch.rawOcrData } : {}),
            ...(ctx.patch.extractedStructuredData !== undefined
              ? { extractedStructuredData: ctx.patch.extractedStructuredData }
              : {}),
            ...(ctx.patch.graphs !== undefined ? { graphs: ctx.patch.graphs } : {}),
            lastHeartbeatAt: new Date(),
          })
          .catch((dbErr) => {
            console.warn(
              `[runExtraction] Checkpoint DB save failed for ${currentStage}:`,
              dbErr.message,
            );
          });
      }
    }

    // emitter.done();
    emitter.done(undefined, {
      documentId: ctx.savedResult?.document?.id || ctx.checkpointData?.documentId || null,
      document: ctx.savedResult?.document || null,
    });

    if (jobId) {
      await documentProcessingJobRepository
        .markCompleted(jobId, {
          percentage: 100,
          status: StageType.COMPLETED,
          completedStages,
          checkpointData: ctx.checkpointData,
        })
        .catch(() => {});
    }

    record.status = StageType.COMPLETED;
    record.result = ctx.savedResult;

    return {
      fileKey,
      status: StageType.COMPLETED,
      documentId: ctx.savedResult?.document?.id || ctx.checkpointData?.documentId || null,
      document: ctx.savedResult?.document || null,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    console.error(`[extraction:${fileKey || "unknown"}] failed at ${currentStage}:`, error);

    const isFatal =
      FATAL_ERROR_CODES.has(error?.errorCode) ||
      error?.retryable === false ||
      (job?.attemptCount && job.attemptCount >= (env.documentMaxRetryAttempts || 3));
    const retryable = !isFatal;
    const requiresReupload = [
      DOCUMENT_STAGES.QUEUED,
      DOCUMENT_STAGES.VALIDATING,
      DOCUMENT_STAGES.UPLOADING,
    ].includes(currentStage);

    if (jobId) {
      await documentProcessingJobRepository
        .checkpointStage(jobId, {
          status: isFatal ? "REJECTED" : "FAILED",
          stage: currentStage,
          stageStatus: StageType.FAILED,
          retryable,
          requiresReupload,
          error: error?.message || String(error || "PIPELINE_FAILED"),
          lastHeartbeatAt: new Date(),
        })
        .catch((dbErr) => {
          console.error("[runExtraction] failed to persist failure state:", dbErr.message);
        });
    }

    emitter.error(currentStage, error, {
      errorCode: error?.errorCode || "PIPELINE_FAILED",
      retryable,
      requiresReupload,
      failedStage: currentStage,
      resumeStage: currentStage,
    });

    record.status = isFatal ? "REJECTED" : StageType.FAILED;
    record.errorCode = error?.errorCode || "PIPELINE_FAILED";
    record.failedStage = currentStage;
    record.retryable = retryable;
    record.requiresReupload = requiresReupload;

    return null;
  }
}

module.exports = new DocumentService();
module.exports.runExtraction = runExtraction;
module.exports.runWithConcurrency = runWithConcurrency;
module.exports.resolveRawOcrData = resolveRawOcrData;
