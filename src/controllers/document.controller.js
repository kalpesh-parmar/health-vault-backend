/**
 * Document CRUD controller.
 *
 * Note: the legacy `addDocument` controller has been removed. The new
 * upload → run-ocr → add flow lives in `documentFlowController.js`. This
 * file keeps only the read/delete/download endpoints.
 */

const { StatusCodes } = require("http-status-codes");
const { messageConstants } = require("../constants/messageConstants");
const { paginatedSuccessResponse, successResponse } = require("../helpers/generalResponse");
const documentService = require("../services/document.service");

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
  const result = await documentService.retryDocument({
    fileKey: req?.query?.fileKey,
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
};
