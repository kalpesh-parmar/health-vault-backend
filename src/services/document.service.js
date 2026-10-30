/**
 * Document CRUD service with Resumable and Retryable Pipeline Execution.
 */

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
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
const { newBatchId, newFileKey, normalizeFiles, getPageCount } = require("../utils/fileUtils");
const { ALLOWED_MIME_TYPES } = require("../configs/fileConfig");
const { StageType } = require("../enums/stageStatus");
const { ProgressEmitter } = require("./progressEmitter.service");
const { DOCUMENT_STAGES, STAGE_WEIGHTS } = require("../constants/documentProgress.constants");
const { env } = require("../configs/env");
const { FileCategory } = require("../enums/fileCategory");
const aiServiceClient = require("../clients/aiServiceClient");
const { ocrOrchestrator, ocrService, embeddingService } = require("./ai");
const documentPersistenceService = require("./documentPersistence.service");
const aiClient = require("./ai/clients/aiClient.service");
const { normalizeLanguage, extractKeyPoints } = require("../helpers/summary.helper");

const documentQueue = require("./queue/documentQueue.service");
const { documentType } = require("../enums/documentType");

const defaultProvider = ocrOrchestrator;

function computeFileSha256(file) {
  if (!file) return "";
  const hash = crypto.createHash("sha256");
  if (file.buffer && Buffer.isBuffer(file.buffer)) {
    hash.update(file.buffer);
    return hash.digest("hex");
  }
  if (file.path && fs.existsSync(file.path)) {
    const fileBuffer = fs.readFileSync(file.path);
    hash.update(fileBuffer);
    return hash.digest("hex");
  }
  return "";
}

const CANONICAL_M1_STAGES = [
  "VALIDATING",
  "UPLOADING",
  "OCR_RUNNING",
  "PARSING",
  "GRAPH_EXTRACTION",
  "FIELD_EXTRACTION",
  "ANALYZING",
  "SUMMARIZING",
  "EMBEDDING",
];

function calculateResumeFromStage(job) {
  const failedStage =
    job?.checkpointData?.failedStage || job?.checkpoint_data?.failedStage || job?.stage;
  if (failedStage && CANONICAL_M1_STAGES.includes(failedStage)) {
    return failedStage;
  }

  const completed = Array.isArray(job?.completedStages)
    ? job.completedStages
    : Array.isArray(job?.completed_stages)
      ? job.completed_stages
      : Array.isArray(job?.checkpointData?.completedStages)
        ? job.checkpointData.completedStages
        : Array.isArray(job?.checkpoint_data?.completedStages)
          ? job.checkpoint_data.completedStages
          : [];
  for (const stage of CANONICAL_M1_STAGES) {
    if (!completed.includes(stage)) {
      return stage;
    }
  }
  return "VALIDATING";
}

function resolveStorageKey(job) {
  const uploadKey = job?.checkpointData?.UPLOADING?.s3Key;
  const candidates = [
    uploadKey,
    job?.checkpointData?.s3Key,
    job?.metadata?.key,
    job?.metadata?.s3Key,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && c.includes("/")) {
      return c.trim();
    }
  }
  for (const c of candidates) {
    if (typeof c === "string" && c.trim() && !c.trim().startsWith("doc_")) {
      return c.trim();
    }
  }
  return job?.checkpointData?.s3Key || job?.metadata?.key || job?.metadata?.s3Key || job?.fileKey;
}

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

const COMPUTE_HEAVY_STAGES = new Set([
  DOCUMENT_STAGES.OCR_RUNNING,
  DOCUMENT_STAGES.FIELD_EXTRACTION,
  DOCUMENT_STAGES.SUMMARIZING,
]);

function getAdaptiveStageTimeout(pipelineStep, ctx) {
  const baseTimeout = pipelineStep?.timeoutMs || 120000;
  if (!pipelineStep || !COMPUTE_HEAVY_STAGES.has(pipelineStep.stage)) {
    return baseTimeout;
  }
  const pageCount = Math.max(
    1,
    ctx?.totalPages || ctx?.checkpointData?.pageCount || ctx?.record?.totalPages || 1,
  );
  const extraPages = Math.max(0, pageCount - 1);
  return Math.max(baseTimeout, baseTimeout + extraPages * 30000);
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

      const filePath = ctx.file?.path;
      const fileBuffer = ctx.file?.buffer;
      if (!filePath && !fileBuffer) {
        throw new InvalidRequestException("File path or buffer required for validation stage");
      }

      ctx.emitter.stage(
        DOCUMENT_STAGES.VALIDATING,
        StageType.IN_PROGRESS,
        messageConstants.CHECK_DOCUMENT_IS_MEDICAL,
      );

      const validationResult = await aiServiceClient.validateMedicalDocument({
        file: filePath || fileBuffer,
        fileName: ctx.file?.originalname || ctx.record?.fileName,
        mimeType: ctx.file?.mimetype || ctx.record?.mimeType,
      });

      if (!validationResult || validationResult.isMedical !== true) {
        const failReason =
          validationResult?.reason || errorConstants.UPLOADED_FILE_NOT_A_VALID_MEDICAL_DOCUMENT;
        throw new NonMedicalDocumentException(failReason, validationResult);
      }

      ctx.checkpointData.validation = validationResult;

      const totalPages =
        ctx.totalPages ||
        ctx.checkpointData?.pageCount ||
        (await getPageCount(ctx.file || ctx.file?.path || ctx.file?.buffer));
      ctx.totalPages = totalPages;
      ctx.checkpointData.pageCount = totalPages;
      ctx.emitter?.setTotalPages?.(totalPages);
    },
  },
  {
    stage: DOCUMENT_STAGES.UPLOADING,
    timeoutMs: env.stageTimeoutMs || 120000,
    message: messageConstants.UPLOADING_DOCUMENT,
    isSatisfied: (ctx) =>
      !ctx.file?.buffer &&
      !ctx.file?.path &&
      Boolean(
        ctx.job?.checkpointData?.uploaded &&
        (ctx.job?.checkpointData?.s3Bucket || ctx.record?.bucket),
      ),
    run: async (ctx) => {
      if (!ctx.file?.buffer && !ctx.file?.path) {
        throw new InvalidRequestException(
          errorConstants.FILE_REQUIRED_FOR_UPLOADING_STAGE ||
            errorConstants.FILE_BUFFER_REQUIRED_FOR_UPLOADING_STAGE,
        );
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
      ctx.checkpointData.s3Key = fileKey;

      if (ctx.file?.path && fs.existsSync(ctx.file.path)) {
        fs.unlink(ctx.file.path, () => {});
      }
    },
  },
  {
    stage: DOCUMENT_STAGES.OCR_RUNNING,
    timeoutMs: env.ocrStageTimeoutMs || 300000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) =>
      !ctx.file?.buffer &&
      Boolean(ctx.rawOcrData || ctx.job?.rawOcrData || ctx.job?.checkpointData?.ocrArtifactKey),
    run: async (ctx) => {
      const ocrEngine = ctx.ocr || defaultProvider;
      const bucket = ctx.bucket || ctx.job?.checkpointData?.s3Bucket || env.patientDocumentsBucket;
      const s3Key =
        ctx.s3Key || ctx.checkpointData?.s3Key || ctx.job?.checkpointData?.s3Key || ctx.fileKey;
      const ocrResponse = await ocrEngine.runFromStorage({
        bucket,
        fileKey: s3Key,
        mimeType: ctx.record?.mimeType,
        traceId: `ocr_job_${ctx.fileKey}`,
        onProgress: ({ page, totalPages }) => {
          ctx.emitter.page(page, totalPages);
        },
      });

      ctx.rawOcrData = ocrResponse;
      if (ocrResponse?.metadata?.pageCount) {
        ctx.totalPages = ocrResponse.metadata.pageCount;
        ctx.checkpointData.pageCount = ocrResponse.metadata.pageCount;
        ctx.emitter?.setTotalPages?.(ocrResponse.metadata.pageCount);
      }

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
    stage: DOCUMENT_STAGES.SUMMARIZING,
    timeoutMs: env.llmStageTimeoutMs || 180000,
    message: messageConstants.EXTRACTING_DOCUMENT,
    isSatisfied: (ctx) => {
      const preferredLanguage =
        ctx.record?.options?.preferredLanguage ||
        ctx.patientContext?.preferredLanguage ||
        "english";
      const hasEnglish = Boolean(
        ctx.structured?.summaryEnglish || ctx.checkpointData?.summaryEnglish,
      );
      if (preferredLanguage === "english") {
        return hasEnglish || Boolean(ctx.structured?.summary);
      }
      return Boolean(
        (ctx.structured?.summaryInPreferredLanguage ||
          ctx.checkpointData?.summaryInPreferredLanguage) &&
        hasEnglish,
      );
    },
    run: async (ctx) => {
      const preferredLanguage =
        ctx.record?.options?.preferredLanguage ||
        ctx.patientContext?.preferredLanguage ||
        "english";

      let summaryEnglish =
        ctx.structured?.summaryEnglish ||
        ctx.checkpointData?.summaryEnglish ||
        ctx.structured?.summary ||
        "";

      let summaryInPreferredLanguage =
        ctx.structured?.summaryInPreferredLanguage ||
        ctx.checkpointData?.summaryInPreferredLanguage ||
        "";

      const rawOcr = await resolveRawOcrData(ctx);
      const rawTextToSummarize = rawOcr?.fullText || "";

      // 1. Ensure English summary exists
      if (!summaryEnglish && rawTextToSummarize) {
        try {
          summaryEnglish = await ocrService.generateSummary(rawTextToSummarize, "english");
          console.log("[runExtraction] Generated summaryEnglish:", summaryEnglish?.slice(0, 80));
        } catch (sumErr) {
          console.warn("[runExtraction] English summary generation failed:", sumErr.message);
        }
      }

      // 2. Ensure Preferred Language summary exists
      if (preferredLanguage === "english") {
        summaryInPreferredLanguage = summaryEnglish;
      } else if (!summaryInPreferredLanguage) {
        if (rawTextToSummarize) {
          try {
            summaryEnglish = await ocrService.generateSummary(rawTextToSummarize, "english");
            console.log("[ocrService.generateSummary] summaryEnglish", summaryEnglish);
            ctx.checkpointData.summaryEnglish = summaryEnglish;
            if (ctx.structured) {
              ctx.structured.summaryEnglish = summaryEnglish;
              ctx.patch.extractedStructuredData = ctx.structured;
            }
          } catch (sumErr) {
            console.warn("[runExtraction] summary fallback failed:", sumErr.message);
          }
        }
        if (!summaryInPreferredLanguage && summaryEnglish) {
          try {
            summaryInPreferredLanguage = await ocrService.translateSummary(
              summaryEnglish,
              preferredLanguage,
            );
            console.log(
              `[runExtraction] Translated summary to ${preferredLanguage}:`,
              summaryInPreferredLanguage?.slice(0, 80),
            );
          } catch (transErr) {
            console.warn(
              `[runExtraction] Summary translation to ${preferredLanguage} failed:`,
              transErr.message,
            );
          }
        }
      }

      const normSummaryLang = normalizeLanguage(preferredLanguage);
      const keyPoints = extractKeyPoints(
        ctx.structured,
        summaryInPreferredLanguage || summaryEnglish,
        normSummaryLang,
      );

      ctx.checkpointData.summaryEnglish = summaryEnglish;
      ctx.checkpointData.summaryInPreferredLanguage = summaryInPreferredLanguage;
      ctx.checkpointData.summaryLanguage = normSummaryLang;
      ctx.checkpointData.keyPoints = keyPoints;

      if (ctx.structured) {
        ctx.structured.summaryEnglish = summaryEnglish;
        ctx.structured.summaryInPreferredLanguage = summaryInPreferredLanguage;
        ctx.structured.summary =
          preferredLanguage !== "english" && summaryInPreferredLanguage
            ? summaryInPreferredLanguage
            : summaryEnglish || summaryInPreferredLanguage;
        ctx.structured.summaryLanguage = normSummaryLang;
        ctx.structured.keyPoints = keyPoints;
        ctx.structured.summariesByLanguage = {
          ...(ctx.structured.summariesByLanguage || {}),
          english: summaryEnglish,
          ...(preferredLanguage !== "english" && summaryInPreferredLanguage
            ? { [preferredLanguage]: summaryInPreferredLanguage }
            : {}),
        };
        ctx.patch.extractedStructuredData = ctx.structured;
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
          s3Key: ctx.job?.metadata?.s3Key || ctx.job?.metadata?.key || ctx.fileKey,
          s3bucket: bucket,
          fileName:
            ctx.job?.metadata?.originalName || ctx.record?.fileName || ctx.file?.originalname,
          fileType: ctx.job?.metadata?.mimeType || ctx.record?.mimeType || ctx.file?.mimetype,
          fileSize:
            ctx.record?.sizeBytes ||
            ctx.file?.size ||
            ctx.job?.metadata?.fileSize ||
            ctx.job?.checkpointData?.fileSize ||
            0,
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
    this._reconcileRunningJobsOnBoot();
  }

  async _reconcileRunningJobsOnBoot() {
    try {
      const recovered = await documentQueue.resumeOrphanedJobsOnBoot();
      if (recovered && recovered.length > 0) {
        const resumed = recovered.filter((r) => r.resumed).length;
        console.log(
          `[BootRecovery] Processed ${recovered.length} orphaned jobs (${resumed} resumed, ${recovered.length - resumed} marked for reupload).`,
        );
      }
    } catch (err) {
      console.warn("[BootRecovery] startup recovery failed:", err.message);
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

    const summaries = rows.map((doc) => {
      let struct = doc.structuredExtractedData;
      if (typeof struct === "string") {
        try {
          struct = JSON.parse(struct);
        } catch {
          struct = {};
        }
      }
      return {
        id: doc.id,
        fileName: doc.fileName,
        documentType: doc.documentType,
        summaryEnglish: doc.summaryEnglish || struct?.summaryEnglish || null,
        summaryInPreferredLanguage:
          struct?.summaryInPreferredLanguage || doc.summaryInPreferredLanguage || null,
        summary:
          struct?.summaryInPreferredLanguage || struct?.summary || doc.summaryEnglish || null,
        summariesByLanguage: struct?.summariesByLanguage || {},
        createdAt: doc.createdAt,
      };
    });

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

  async uploadDocuments(files, authUserId, overrideLanguage) {
    try {
      if (!authUserId) {
        throw new InvalidRequestException(errorConstants.UNAUTHORIZED_ACCESS_TO_PATIENT_RESOURCE);
      }

      const tPatient = Date.now();
      const existingPatient = await patientRepository.findById(authUserId);
      console.log(
        `  [NODE TIMING] [uploadDocuments] patientRepository.findById took ${Date.now() - tPatient}ms`,
      );
      if (!existingPatient) {
        throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
      }

      const list = normalizeFiles(files);
      if (!list || !Array.isArray(list) || list.length === 0) {
        throw new InvalidRequestException(errorConstants.AT_LEAST_ONE_DOCUMENT_FILE_IS_REQUIRED);
      }
      if (list?.length > (env.maxFilesPerUpload || 20)) {
        throw new InvalidRequestException(
          errorConstants.MAXIMUM_FIVE_DOCUMENT_FILES_ALLOWED(env.maxFilesPerUpload || 20),
        );
      }

      const executeUpload = async () => {
        const patientId = authUserId;
        let preferredLanguage = existingPatient.preferredLanguage || "english";
        if (overrideLanguage && typeof overrideLanguage === "string") {
          preferredLanguage = normalizeLanguage(overrideLanguage);
        }

        const batchId = newBatchId();
        const fileKeys = list.map(() => newFileKey());

        sseConnectionService.registerBatch(batchId, fileKeys);
        const jobs = await Promise.all(
          list.map(async (file, index) => {
            const fileKey = fileKeys[index];
            const tPage = Date.now();
            const pageCount = await getPageCount(file);
            console.log(
              `  [NODE TIMING] [uploadDocuments] getPageCount took ${Date.now() - tPage}ms (pages=${pageCount})`,
            );
            const sha256 = computeFileSha256(file);

            // 2.5 Check if an active/recent job already exists for this exact file SHA-256
            const tSha = Date.now();
            const existingShaJob = await documentProcessingJobRepository.findActiveJobBySha256(
              authUserId,
              sha256,
              60,
            );
            console.log(
              `  [NODE TIMING] [uploadDocuments] findActiveJobBySha256 took ${Date.now() - tSha}ms (hit=${Boolean(existingShaJob)})`,
            );
            if (existingShaJob) {
              let isReusable = true;
              if (existingShaJob.status === "COMPLETED") {
                const docS3Key =
                  existingShaJob.metadata?.s3Key ||
                  existingShaJob.metadata?.key ||
                  existingShaJob.checkpointData?.s3Key ||
                  existingShaJob.fileKey;
                const activeDoc = await documentRepository
                  .findByFileKey(docS3Key, authUserId)
                  .catch(() => null);
                if (!activeDoc) {
                  isReusable = false;
                }
              }

              if (isReusable) {
                console.log(
                  `[uploadDocuments] SHA-256 deduplication hit: reusing existing job ${existingShaJob.id} for file ${file?.originalname || fileKey}`,
                );
                return {
                  jobId: existingShaJob.id,
                  fileKey: existingShaJob.fileKey,
                  documentId: existingShaJob.metadata?.documentId || null,
                  fileName: existingShaJob.originalName || file?.originalname || "",
                  status: existingShaJob.status,
                  streamUrl: `/sse/files/${existingShaJob.fileKey}/stream`,
                };
              }
            }

            let s3Key = null;
            let canonicalDocumentId = null;
            let jobRow = null;

            try {
              // 1. Node BFF owns S3/MinIO upload of original file
              const tS3 = Date.now();
              const uploadResult = await objectStorageService.uploadFile(
                file,
                FileCategory.DOCUMENT,
                patientId,
              );
              console.log(
                `  [NODE TIMING] [uploadDocuments] objectStorageService.uploadFile (S3) took ${Date.now() - tS3}ms`,
              );
              s3Key = uploadResult?.fileKey || uploadResult?.s3Key || fileKey;
              const bucket =
                uploadResult?.s3Bucket ||
                uploadResult?.bucket ||
                (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName) ||
                env.patientDocumentsBucket;

              const canonicalDocumentId = crypto.randomUUID();
              // Flow Requirement: On upload, only enter in document_processing_jobs.
              // No initial row is entered in documents table until processing completes.
              /*

              // 1.5 Create or link initial canonical document record in documents table
              const tUpsert = Date.now();
              const initialDoc = await documentRepository.upsertInitialDocument({
                id: documentId,
                userId: authUserId,
                documentType: documentType.OTHER_MEDICAL_DOCUMENT,
                fileName: file?.originalname || "",
                s3Bucket: bucket,
                s3Key,
                fileType: inferFileType(file?.mimetype),
                fileSize: file?.size || 0,
                ocrStatus: ocrStatus.PENDING,
              });
              console.log(
                `  [NODE TIMING] [uploadDocuments] documentRepository.upsertInitialDocument took ${Date.now() - tUpsert}ms`,
              );
              */

              // 2. Node creates initial document_processing_jobs row with status=QUEUED
              const tJob = Date.now();
              jobRow = await documentProcessingJobRepository.createQueuedJob({
                fileKey: fileKey,
                userId: authUserId,
                mimeType: file?.mimetype || "",
                originalName: file?.originalname || "",
                pageCount,
                metadata: {
                  bucket,
                  key: s3Key,
                  s3Key,
                  sha256,
                  patientId,
                  documentId: canonicalDocumentId,
                  batchId,
                  documentType: documentType.OTHER_MEDICAL_DOCUMENT,
                  preferredLanguage,
                  processor: "python",
                  mimeType: file?.mimetype || "",
                  originalName: file?.originalname || "",
                  fileSize: file?.size || 0,
                },
                checkpointData: {
                  pageCount,
                  uploaded: true,
                  s3Bucket: bucket,
                  s3Key,
                  sha256,
                  documentId: canonicalDocumentId,
                  fileSize: file?.size || 0,
                },
              });
              console.log(
                `  [NODE TIMING] [uploadDocuments] documentProcessingJobRepository.createQueuedJob took ${Date.now() - tJob}ms`,
              );

              const emitter = ProgressEmitter.for({
                fileKey: fileKey,
                fileName: file?.originalname || "",
                batchId,
                patientId,
                totalPages: pageCount,
              });

              emitter.stage(
                StageType.QUEUED,
                StageType.STARTED,
                messageConstants.QUEUE_FOR_EXTRACTION,
              );

              // 3. Pointer-only dispatch payload: zero file bytes sent across HTTP
              const dispatchPayload = {
                jobId: jobRow.id,
                patientId,
                documentId: canonicalDocumentId,
                storage: {
                  bucket,
                  key: s3Key,
                  sha256,
                },
                documentType: documentType.OTHER_MEDICAL_DOCUMENT,
                preferredLanguage: preferredLanguage === "english" ? "en" : preferredLanguage,
                resumeFromStage: null,
              };

              const tDispatch = Date.now();
              await aiServiceClient.dispatchDocumentProcessing(dispatchPayload);
              console.log(
                `  [NODE TIMING] [uploadDocuments] aiServiceClient.dispatchDocumentProcessing took ${Date.now() - tDispatch}ms`,
              );

              return {
                jobId: jobRow.id,
                fileKey: fileKey,
                documentId: canonicalDocumentId,
                fileName: file?.originalname || "",
                status: StageType.QUEUED,
              };
            } catch (fileErr) {
              console.error(`[uploadDocuments] Failure processing file ${fileKey}:`, fileErr);
              // If initial document and job row were created, mark them as retryable failure
              // instead of deleting them, so the user can retry without re-uploading.
              if (jobRow && canonicalDocumentId) {
                const failureMessage = "AI OCR service temporarily unavailable. Please retry.";
                await documentProcessingJobRepository
                  .markFailed(jobRow.id, fileErr, {
                    retryable: true,
                    message: failureMessage,
                  })
                  .catch(() => {});
                // Flow Requirement: on failure, do not update documents table. Job stays in document_processing_jobs.
                // await documentRepository
                //   .update(canonicalDocumentId, {
                //     ocrStatus: ocrStatus.FAILED,
                //   })
                //   .catch(() => {});
                /*
// ocrStatus: ocrStatus.FAILED,
                  })
                  .catch(() => {});
                */
                const emitter = ProgressEmitter.for({
                  fileKey: fileKey,
                  fileName: file?.originalname || "",
                  batchId,
                  patientId,
                  totalPages: pageCount,
                });
                emitter.stage(StageType.FAILED, StageType.FAILED, failureMessage, {
                  retryable: true,
                  errorCode: "AI_SERVICE_UNAVAILABLE",
                });
                return {
                  jobId: jobRow.id,
                  fileKey: fileKey,
                  documentId: canonicalDocumentId,
                  fileName: file?.originalname || "",
                  status: StageType.FAILED,
                  retryable: true,
                };
              }
              // Compensating rollback if S3 or initial DB creation failed before job was created
              if (s3Key) {
                await objectStorageService.deleteFile(s3Key).catch(() => {});
              }
              /* if (canonicalDocumentId) {
                // Flow Requirement: on failure, do not update documents table. Job stays in document_processing_jobs.
                // await documentRepository
                //   .update(canonicalDocumentId, {
                //     ocrStatus: ocrStatus.FAILED,
                //   })
                //   .catch(() => {});
// .deleteDocument(canonicalDocumentId, authUserId) /*
                  .catch(() => {});
              }
              */
              throw fileErr;
            }
          }),
        );

        return {
          batchId,
          patientId,
          total: jobs.length,
          batchUrl: `/sse/batches/${batchId}/stream`,
          documents: jobs.map((j) => ({
            jobId: j.jobId,
            fileKey: j.fileKey,
            documentId: j.documentId,
            fileName: j.fileName,
            status: j.status,
            streamUrl: `/sse/files/${j.fileKey}/stream`,
          })),
        };
      };

      return await executeUpload();
    } catch (error) {
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
    const activeFileKey = job.fileKey || fileKey;
    if (job.status === "RUNNING") {
      return {
        jobId: job.id,
        fileKey: activeFileKey,
        status: "RUNNING",
        resumeStage: job.stage || DOCUMENT_STAGES.QUEUED,
        progress: job.percentage || 0,
        streamUrl: `/sse/files/${activeFileKey}/stream`,
      };
    }

    const requiresReupload =
      job.requiresReupload ||
      [DOCUMENT_STAGES.QUEUED, DOCUMENT_STAGES.VALIDATING, DOCUMENT_STAGES.UPLOADING].includes(
        job.stage,
      );

    if (requiresReupload && (!file || (!file.buffer && !file.path))) {
      throw new InvalidRequestException(
        "This stage failure requires re-uploading the file payload.",
      );
    }

    let updatedSha256 = job.checkpointData?.sha256 || job.metadata?.sha256;
    let updatedBucket =
      job.checkpointData?.s3Bucket ||
      job.metadata?.bucket ||
      (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName) ||
      env.patientDocumentsBucket;
    let updatedKey = resolveStorageKey(job);

    if (file) {
      updatedSha256 = computeFileSha256(file);
      const uploadResult = await objectStorageService.uploadFile(
        file,
        FileCategory.DOCUMENT,
        userId,
      );
      if (uploadResult?.s3Bucket || uploadResult?.bucket) {
        updatedBucket = uploadResult?.s3Bucket || uploadResult?.bucket;
      }
      if (uploadResult?.fileKey || uploadResult?.s3Key) {
        updatedKey = uploadResult?.fileKey || uploadResult?.s3Key;
      }
    }

    const resumeFromStage = calculateResumeFromStage(job);

    // Acquire atomic retry lock (prevent duplicate retry races)
    const claimed = await documentProcessingJobRepository.claimJobForRetryReEnqueue(job.id, {
      status: "QUEUED",
      stageStatus: "QUEUED",
      error: null,
      metadata: {
        ...(job.metadata || {}),
        processor: "python",
        ...(updatedSha256 ? { sha256: updatedSha256 } : {}),
        bucket: updatedBucket,
        key: updatedKey,
        s3Key: updatedKey,
      },
      checkpointData: {
        ...(job.checkpointData || {}),
        s3Bucket: updatedBucket,
        s3Key: updatedKey,
        uploaded: true,
        failedStage: job.stage || job.checkpointData?.failedStage,
        ...(updatedSha256 ? { sha256: updatedSha256 } : {}),
      },
    });

    if (!claimed) {
      // Another worker or request already claimed the retry lease
      return {
        jobId: job.id,
        fileKey: activeFileKey,
        status: "RUNNING",
        resumeStage: resumeFromStage || job.stage || DOCUMENT_STAGES.QUEUED,
        progress: job.percentage || 0,
        streamUrl: `/sse/files/${activeFileKey}/stream`,
      };
    }

    sseConnectionService.reopen(activeFileKey);
    if (fileKey && fileKey !== activeFileKey) {
      sseConnectionService.reopen(fileKey);
    }
    if (job.metadata?.batchId) {
      sseConnectionService.unmarkDocumentDone(job.metadata.batchId, activeFileKey);
      if (fileKey && fileKey !== activeFileKey) {
        sseConnectionService.unmarkDocumentDone(job.metadata.batchId, fileKey);
      }
    }

    const retryEvent = {
      type: "document.retrying",
      stage: resumeFromStage || job.stage || DOCUMENT_STAGES.QUEUED,
      stageStatus: "QUEUED",
      percentage: job.percentage || 0,
      progress: job.percentage || 0,
      message: `Resuming execution from stage ${resumeFromStage || job.stage}`,
      failedStage: job.stage || job.checkpointData?.failedStage,
      attemptCount: (job.attemptCount || 1) + 1,
    };
    sseConnectionService.publish(activeFileKey, retryEvent);
    if (fileKey && fileKey !== activeFileKey) {
      sseConnectionService.publish(fileKey, retryEvent);
    }

    const dispatchPayload = {
      jobId: job.id,
      patientId: job.userId || userId,
      documentId: job.metadata?.documentId || crypto.randomUUID(),
      storage: {
        bucket: updatedBucket,
        key: updatedKey,
        sha256: updatedSha256 || "",
      },
      documentType: job.metadata?.documentType || documentType.OTHER_MEDICAL_DOCUMENT,
      preferredLanguage:
        (job.metadata?.preferredLanguage || "en") === "english"
          ? "en"
          : job.metadata?.preferredLanguage || "en",
      resumeFromStage,
    };

    await aiServiceClient.dispatchDocumentProcessing(dispatchPayload);

    const resumeStage = resumeFromStage || job.stage || DOCUMENT_STAGES.QUEUED;
    const progress = STAGE_WEIGHTS[resumeStage]?.[0] ?? job.percentage ?? 0;

    return {
      jobId: job.id,
      fileKey: activeFileKey,
      status: "RUNNING",
      resumeStage,
      progress,
      streamUrl: `/sse/files/${activeFileKey}/stream`,
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

/** Run one document and fold the result back into the record. */
async function processOne({ file, record, emitter, job = null }) {
  record.status = StageType.IN_PROGRESS;

  const result = await runExtraction({ file, record, emitter, job });

  if (result) {
    Object.assign(record, result);
  } else {
    record.status = record.status || StageType.FAILED;
    record.errorCode = record?.errorCode || "PIPELINE_FAILED";
  }
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

  const totalPages =
    record?.totalPages || job?.checkpointData?.pageCount || (file ? await getPageCount(file) : 1);

  const checkpointData = { pageCount: totalPages, ...(job?.checkpointData || {}) };
  const completedStages = [...(job?.completedStages || [])];

  if (emitter?.setTotalPages) {
    emitter.setTotalPages(totalPages);
  }

  const ctx = {
    file,
    record,
    emitter,
    totalPages,
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

      const timeoutMs = getAdaptiveStageTimeout(pipelineStep, ctx);
      await withTimeout(pipelineStep.run(ctx), timeoutMs, currentStage);

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
  } finally {
    if (ctx.file?.path && fs.existsSync(ctx.file.path)) {
      if (
        ctx.checkpointData?.uploaded ||
        [StageType.COMPLETED, StageType.FAILED, "REJECTED"].includes(record.status)
      ) {
        fs.unlink(ctx.file.path, () => {});
      }
    }
  }
}

documentQueue.setRunner(runExtraction);

module.exports = new DocumentService();
module.exports.runExtraction = runExtraction;
module.exports.runWithConcurrency = runWithConcurrency;
module.exports.resolveRawOcrData = resolveRawOcrData;
module.exports.getAdaptiveStageTimeout = getAdaptiveStageTimeout;
module.exports.STAGES_PIPELINE = STAGES_PIPELINE;
