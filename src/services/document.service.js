/**
 * Document CRUD service.
 *
 * Scope after the refactor
 * ────────────────────────
 * This module is now strictly READ + DELETE + storage helpers. All
 * write paths that ingest a new document go through:
 *
 *   POST /documents/upload       → documentUploadService
 *   POST /documents/run-ocr      → documentOcrJobService (async)
 *   POST /documents/add          → documentPersistenceService
 *
 * The old direct `createDocument()` ingestion path has been removed.
 * The new `add-document` flow stores the FE-confirmed payload
 * inside a single transaction (see documentPersistenceService).
 */

const path = require("path");

const { errorConstants } = require("../constants/errorConstants");
const { messageConstants } = require("../constants/messageConstants");
const { NotFoundException, InvalidRequestException } = require("../exceptions/appError");
const documentRepository = require("../repositories/documentRepository");
const patientRepository = require("../repositories/patientRepository");
const chatSessionRepository = require("../repositories/chatSessionRepository");
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
const { STAGES } = require("../constants/ocrStages");
const { OCR_CONCURRENCY, ALLOWED_MIME_TYPES } = require("../configs/fileConfig");
const { StageType } = require("../enums/stageStatus");
const { ProgressEmitter } = require("./progressEmitter.service");
const { DOCUMENT_STAGES } = require("../constants/documentProgress.constants");
const { env } = require("../configs/env");
const { FileCategory } = require("../enums/fileCategory");
const aiServiceClient = require("../clients/aiServiceClient");
const { ocrOrchestrator, ocrService, embeddingService } = require("./ai");
const documentPersistenceService = require("./documentPersistence.service");
const aiClient = require("./ai/clients/aiClient.service");

const defaultProvider = ocrOrchestrator;
const documentStore = new Map();

class DocumentService {
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

      const jobs = list.map((file, index) => {
        const record = {
          fileKey: fileKeys[index],
          batchId,
          patientId,
          uploadedBy: authUserId,
          fileName: file?.originalname || "",
          mimeType: file?.mimetype || "",
          sizeBytes: file?.size || 0,
          status: STAGES.OCR_QUEUED,
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

        return { file, record, emitter };
      });

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
        documents: jobs.map(({ record }) => ({
          fileKey: record.fileKey,
          fileName: record.fileName,
          status: record.status,
          streamUrl: `/sse/files/${record.fileKey}/stream`,
        })),
      };
    } catch (error) {
      // eslint-disable-next-line no-console
      console.error("Error in file upload: ", error);
      // for (const key of uploadedFileKeys) {
      //   try {
      //     await objectStorageService.deleteFile(key);
      //   } catch (cleanupErr) {
      //     // eslint-disable-next-line no-console
      //     console.warn(`[DocumentService] Cleanup failed for file key ${key}:`, cleanupErr.message);
      //   }
      // }
      throw error;
    }
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
async function processOne({ file, record, emitter }) {
  record.status = StageType.IN_PROGRESS;
  documentStore.set(record.fileKey, record);

  const result = await runExtraction({ file, record, emitter });

  if (result) {
    Object.assign(record, result);
  } else {
    record.status = StageType.FAILED;
    record.errorCode = record?.errorCode || "PIPELINE_FAILED";
  }
  documentStore.set(record.fileKey, record);
  return result;
}

async function runExtraction({ file, record, emitter, ocr = defaultProvider }) {
  const startedAt = Date.now();
  try {
    const patientId = record?.patientId || record?.uploadedBy;

    // 1. VALIDATING stage: Format & MIME type check
    emitter.stage(
      DOCUMENT_STAGES.VALIDATING,
      StageType.STARTED,
      messageConstants.VALIDATE_DOCUMENT_FORMAT,
    );

    const isMimeAllowed =
      record?.mimeType &&
      (ALLOWED_MIME_TYPES.PATIENT_DOCUMENT.has
        ? ALLOWED_MIME_TYPES.PATIENT_DOCUMENT.has(record.mimeType)
        : Array.from(ALLOWED_MIME_TYPES.PATIENT_DOCUMENT).includes(record.mimeType));

    if (!record || !isMimeAllowed) {
      emitter.error(DOCUMENT_STAGES.VALIDATING, errorConstants.INVALID_DOCUMENT_TYPE);
      record.status = StageType.FAILED;
      record.errorCode = "INVALID_DOCUMENT_TYPE";
      return null;
    }

    // 2. VALIDATING stage: Medical Document Validation API
    emitter.stage(
      DOCUMENT_STAGES.VALIDATING,
      StageType.IN_PROGRESS,
      messageConstants.CHECK_DOCUMENT_IS_MEDICAL,
    );

    const validationResult = await aiServiceClient.validateMedicalDocument({
      file: file.buffer,
      fileName: file.originalname,
      mimeType: file.mimetype,
    });

    if (!validationResult || validationResult.isMedical !== true) {
      const failReason =
        validationResult?.reason || errorConstants.UPLOADED_FILE_NOT_A_VALID_MEDICAL_DOCUMENT;
      emitter.error(DOCUMENT_STAGES.VALIDATING, failReason);
      return null;
    }

    // 3. UPLOADING stage: Upload file to storage
    emitter.stage(
      DOCUMENT_STAGES.UPLOADING,
      StageType.IN_PROGRESS,
      messageConstants.UPLOADING_DOCUMENT,
    );
    const uploadResult = await objectStorageService.uploadFile(
      file,
      FileCategory.DOCUMENT,
      patientId,
    );

    const fileKey = uploadResult?.fileKey || uploadResult?.s3Key || record.fileKey;
    const bucket =
      uploadResult?.s3Bucket ||
      uploadResult?.bucket ||
      (env.storageProvider === "gcp" ? env.gcpStorageBucket : env.awsBucketName) ||
      env.patientDocumentsBucket;

    record.fileKey = fileKey;
    record.bucket = bucket;

    // 4. OCR_RUNNING stage
    emitter.stage(
      DOCUMENT_STAGES.OCR_RUNNING,
      StageType.IN_PROGRESS,
      messageConstants.EXTRACTING_DOCUMENT,
    );
    const ocrEngine = ocr || defaultProvider;
    const ocrResponse = await ocrEngine.runFromStorage({
      bucket,
      fileKey,
      mimeType: record.mimeType,
      traceId: `ocr_job_${fileKey}`,
    });

    // 5. PARSING stage
    emitter.stage(
      DOCUMENT_STAGES.PARSING,
      StageType.IN_PROGRESS,
      messageConstants.EXTRACTING_DOCUMENT,
    );

    // 6. FIELD_EXTRACTION stage
    emitter.stage(
      DOCUMENT_STAGES.FIELD_EXTRACTION,
      StageType.IN_PROGRESS,
      messageConstants.EXTRACTING_DOCUMENT,
    );
    const normalizedData = await ocrService.normalizeExtraction({
      patientContext: record.patientContext || null,
      rawOcr: ocrResponse,
    });

    const { rawOcrData, structured } = normalizedData || {};

    // 7. ANALYZING stage
    emitter.stage(
      DOCUMENT_STAGES.ANALYZING,
      StageType.IN_PROGRESS,
      messageConstants.EXTRACTING_DOCUMENT,
    );

    // 8. SUMMARIZING stage
    emitter.stage(
      DOCUMENT_STAGES.SUMMARIZING,
      StageType.IN_PROGRESS,
      messageConstants.EXTRACTING_DOCUMENT,
    );
    let summaryEnglish = structured?.summary || "";
    const rawTextToSummarize = rawOcrData?.fullText || ocrResponse?.fullText || "";
    if (rawTextToSummarize && !summaryEnglish) {
      try {
        summaryEnglish = await ocrService.generateSummary(rawTextToSummarize, "english");
      } catch (sumErr) {
        console.warn("[runExtraction] summary fallback failed:", sumErr.message);
      }
    }

    // 9. GRAPH_EXTRACTION stage
    emitter.stage(
      DOCUMENT_STAGES.GRAPH_EXTRACTION,
      StageType.IN_PROGRESS,
      messageConstants.EXTRACTING_DOCUMENT,
    );
    let graphs = [];
    if (structured) {
      try {
        graphs = await aiClient.extractGraphs(structured);
      } catch (graphErr) {
        console.warn("[runExtraction] graph extraction failed:", graphErr.message);
      }
    }

    // 10. PERSISTING stage
    emitter.stage(
      DOCUMENT_STAGES.PERSISTING,
      StageType.IN_PROGRESS,
      messageConstants.EXTRACTING_DOCUMENT,
    );
    let savedResult = null;
    try {
      savedResult = await documentPersistenceService.addDocument({
        userId: patientId,
        payload: {
          s3Key: fileKey,
          s3bucket: bucket,
          fileName: record.fileName,
          fileType: record.mimeType,
          fileSize: record.sizeBytes,
          rawOcrData: rawOcrData || ocrResponse,
          extractedStructuredData: structured,
          graphs,
          embeddingsGenerated: false,
        },
      });
    } catch (persistErr) {
      console.warn("[runExtraction] document persistence failed:", persistErr.message);
    }

    // 11. CHUNKING stage
    emitter.stage(
      DOCUMENT_STAGES.CHUNKING,
      StageType.IN_PROGRESS,
      messageConstants.EXTRACTING_DOCUMENT,
    );

    // 12. EMBEDDING stage
    emitter.stage(
      DOCUMENT_STAGES.EMBEDDING,
      StageType.IN_PROGRESS,
      messageConstants.EXTRACTING_DOCUMENT,
    );
    if (savedResult?.document?.id && !savedResult?.embeddings?.embeddings) {
      try {
        await embeddingService.embedAndPersist({
          documentId: savedResult.document.id,
          rawOcr: rawOcrData || ocrResponse,
          structured,
          userId: patientId,
        });
      } catch (embedErr) {
        console.warn("[runExtraction] embedding persistence failed:", embedErr.message);
      }
    }

    // Completion - Single `done()` event
    emitter.done();

    record.status = StageType.COMPLETED;
    record.result = savedResult;
    return {
      fileKey,
      status: StageType.COMPLETED,
      documentId: savedResult?.document?.id || null,
      document: savedResult?.document || null,
      elapsedMs: Date.now() - startedAt,
    };
  } catch (error) {
    console.error("[extraction:" + (record?.fileKey || "unknown") + "]", error);
    emitter.error(DOCUMENT_STAGES.VALIDATING, error?.message || error || "PIPELINE_FAILED");
    record.status = StageType.FAILED;
    record.errorCode = error?.errorCode || "PIPELINE_FAILED";
    return null;
  }
}

module.exports = new DocumentService();
module.exports.runExtraction = runExtraction;
module.exports.runWithConcurrency = runWithConcurrency;
