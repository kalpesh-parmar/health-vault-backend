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

const { db } = require("../configs/db");
const { errorConstants } = require("../constants/errorConstants");
const { messageConstants } = require("../constants/messageConstants");
const { FileCategory } = require("../enums/fileCategory");
const { documentType } = require("../enums/documentType");
const { ocrStatus } = require("../enums/ocrStatus");
const {
  NotFoundException,
  InvalidRequestException,
  UnauthorizedException,
} = require("../exceptions/appError");
const documentRepository = require("../repositories/documentRepository");
const patientRepository = require("../repositories/patientRepository");
const objectStorageService = require("./objectStorage.service");
const documentOcrJobService = require("./documentOcrJob.service");
const {
  idParamSchema,
  listDocumentsFilterSortSchema,
  listDocumentsPaginatedSchema,
  listDocumentsQuerySchema,
  validateSchema,
} = require("../validations");

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

    // Map rows to include only the summary and basic details
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
    const chatSessionRepository = require("../repositories/chatSessionRepository");
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

  async uploadPatientDocuments(patientId, files, authUserId) {
    if (!patientId || patientId !== authUserId) {
      throw new UnauthorizedException("Unauthorized access to patient resource");
    }

    const existingPatient = await patientRepository.findById(patientId);
    if (!existingPatient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    if (!files || !Array.isArray(files) || files.length === 0) {
      throw new InvalidRequestException("At least one document file is required.");
    }

    if (files.length > 5) {
      throw new InvalidRequestException("Maximum 5 document files allowed.");
    }

    const uploadedFileKeys = [];
    try {
      const documentRecords = [];
      for (const file of files) {
        const uploadResult = await objectStorageService.uploadFile(
          file,
          FileCategory.DOCUMENT,
          patientId,
        );
        uploadedFileKeys.push(uploadResult.fileKey);

        const signedUrl = await objectStorageService.getSignedFileUrl(uploadResult.fileKey);

        documentRecords.push({
          userId: patientId,
          documentType: documentType.MEDICAL_DOCUMENT,
          fileName: uploadResult.fileName || file.originalname,
          filePath: uploadResult.fileKey,
          s3Key: uploadResult.fileKey,
          s3Bucket: uploadResult.s3Bucket || null,
          fileType: file.mimetype,
          fileSize: uploadResult.fileSize || file.size,
          ocrStatus: ocrStatus.PENDING,
          _signedUrl: signedUrl,
        });
      }

      const insertPayloads = documentRecords.map(({ _signedUrl, ...rest }) => rest);
      const createdRows = await db.transaction(async (tx) => {
        const rows = await documentRepository.createMany(insertPayloads, tx);
        const jobRows = await Promise.all(
          documentRecords.map((docRec) =>
            documentOcrJobService.createQueuedJob(
              {
                fileKey: docRec.filePath,
                userId: patientId,
                mimeType: docRec.fileType,
                originalName: docRec.fileName,
              },
              tx,
            ),
          ),
        );
        return rows.map((row, idx) => ({
          ...row,
          jobId: jobRows[idx]?.id || null,
        }));
      });

      return createdRows.map((doc, idx) => ({
        ...doc,
        fileKey: doc.filePath || doc.s3Key,
        signedUrl: documentRecords[idx]?._signedUrl || null,
        fileUrl: documentRecords[idx]?._signedUrl || null,
      }));
    } catch (error) {
      console.error("Error in file upload: ", error);
      for (const key of uploadedFileKeys) {
        try {
          await objectStorageService.deleteFile(key);
        } catch (cleanupErr) {
          console.warn(`[DocumentService] Cleanup failed for file key ${key}:`, cleanupErr.message);
        }
      }
      throw error;
    }
  }
}

module.exports = new DocumentService();
