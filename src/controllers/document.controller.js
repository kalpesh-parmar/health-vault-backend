/**
 * Document CRUD controller.
 *
 * Note: the legacy `addDocument` controller has been removed. The new
 * upload → run-ocr → add flow lives in `documentFlowController.js`. This
 * file keeps only the read/delete/download endpoints.
 */

const fs = require("fs");
const { StatusCodes } = require("http-status-codes");
const { paginatedSuccessResponse, successResponse, errorResponse } = require("../helpers/generalResponse");
const documentService = require("../services/document.service");
const documentPreValidationService = require("../services/documentPreValidation.service");
const { messageConstants } = require("../constants/messageConstants");

async function getDocumentById(req, res) {
  const result = await documentService.getDocumentById(req.params.id, req.auth.userId);
  return successResponse(res, result, messageConstants.DOCUMENT_FETCHED);
}

async function getDocumentList(req, res) {
  const result = await documentService.getDocumentList(req.auth.userId, req.query);
  return successResponse(res, result, messageConstants.DOCUMENT_LIST_FETCHED);
}

async function listDocuments(req, res) {
  const result = await documentService.listDocuments(req.auth.userId, req.body);
  return successResponse(res, result, messageConstants.DOCUMENT_FILTERED_LIST_FETCHED);
}

async function listDocumentsPaginated(req, res) {
  const result = await documentService.listDocumentsPaginated(req.auth.userId, req.body);
  return paginatedSuccessResponse(
    res,
    result.items,
    result.page,
    messageConstants.DOCUMENT_FILTERED_LIST_FETCHED,
  );
}

async function deleteDocument(req, res) {
  const result = await documentService.deleteDocument(req.params.id, req.auth.userId);
  return successResponse(res, result, messageConstants.DOCUMENT_DELETED);
}

async function getDownloadFile(req, res) {
  const { fileKey } = req.query;
  const result = await documentService.getDownloadUrl(fileKey);
  return successResponse(res, result, messageConstants.DOCUMENT_DOWNLOAD_URL_FETCHED);
}

async function deleteFile(req, res) {
  const { fileKey } = req.query;
  const result = await documentService.deleteFile(req.auth.userId, fileKey);
  return successResponse(res, result, messageConstants.DOCUMENT_DELETED);
}
async function updateDocument(req, res) {
  const result = await documentService.updateDocument(req.params.id, req.body, req.auth.userId);
  return successResponse(res, result, messageConstants.DOCUMENT_UPDATED);
}

async function getDocumentSummaryList(req, res) {
  const result = await documentService.getDocumentSummaryList(req.auth.userId, req.query);
  return successResponse(res, result, messageConstants.DOCUMENT_SUMMARIES_FETCHED_SUCCESSFULLY);
}

async function retryDocument(req, res) {
  const fileKey = req.body?.fileKey || req.query?.fileKey || req.validatedRetry?.fileKey;
  const result = await documentService.retryDocument({
    fileKey,
    userId: req.auth.userId,
    file: req.files?.[0] || req.file || null,
  });
  return successResponse(
    res,
    result,
    messageConstants.DOCUMENT_RETRY_INITIATED,
    StatusCodes.ACCEPTED,
  );
}

async function uploadDocuments(req, res) {
  const result = await documentService.uploadDocuments(req.files, req.auth.userId);
  return successResponse(res, result, messageConstants.FILE_UPLOADED, StatusCodes.ACCEPTED);
}

async function validateDocuments(req, res) {
  const files = req.files || (req.file ? [req.file] : []);
  const clientFileId = req.body?.clientFileId || null;
  const clientFileIds = req.body?.clientFileIds
    ? (Array.isArray(req.body.clientFileIds) ? req.body.clientFileIds : [req.body.clientFileIds])
    : [];

  try {
    if (!files || files.length === 0) {
      return errorResponse(res, {
        statusCode: StatusCodes.BAD_REQUEST,
        errorCode: "FILE_MISSING",
        message: "At least one file is required for validation",
      });
    }

    const results = [];
    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const assignedId =
        clientFileIds[i] ||
        (i === 0 && clientFileId ? clientFileId : null) ||
        file.originalname ||
        `file_${i}`;
      const fileName = file.originalname || file.name || "document";

      try {
        const validation = await documentPreValidationService.validatePreUploadDocument(file, {
          failOpen: false,
        });

        results.push({
          clientFileId: assignedId,
          fileName,
          isValid: Boolean(validation.isValid),
          documentType: validation.documentType || null,
          code: validation.code || null,
          title: validation.title || null,
          message:
            validation.message ||
            (validation.isValid ? "Document is a valid medical document" : "Validation failed"),
          sha256: validation.sha256 || null,
          cacheHit: Boolean(validation.cacheHit),
        });
      } catch (err) {
        results.push({
          clientFileId: assignedId,
          fileName,
          isValid: false,
          documentType: null,
          code: "VALIDATION_FAILED",
          title: "Validation Error",
          message: err.message || "An unexpected error occurred while validating file.",
          sha256: null,
          cacheHit: false,
        });
      }
    }

    const primary = results[0] || {};
    const responseData = {
      clientFileId: primary.clientFileId || null,
      fileName: primary.fileName || null,
      isValid: primary.isValid !== undefined ? primary.isValid : false,
      documentType: primary.documentType || null,
      code: primary.code || null,
      message: primary.message || "",
      results,
    };

    return successResponse(res, responseData, "Documents validated successfully");
  } finally {
    if (files && Array.isArray(files)) {
      for (const file of files) {
        if (file.path && fs.existsSync(file.path)) {
          fs.unlink(file.path, () => {});
        }
      }
    }
  }
}

module.exports = {
  deleteDocument,
  deleteFile,
  getDocumentById,
  getDocumentList,
  getDocumentSummaryList,
  getDownloadFile,
  listDocuments,
  retryDocument,
  updateDocument,
  listDocumentsPaginated,
  uploadDocuments,
  validateDocuments,
};
