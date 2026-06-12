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

const { errorConstants } = require("../constants/errorConstants");
const { messageConstants } = require("../constants/messageConstants");
const { NotFoundException, InvalidRequestException } = require("../exceptions/appError");
const documentRepository = require("../repositories/documentRepository");
const objectStorageService = require("./objectStorageService");
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
}

module.exports = new DocumentService();
