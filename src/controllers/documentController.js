const { StatusCodes } = require("http-status-codes");
const { messageConstants } = require("../constants/messageConstants");
const { paginatedSuccessResponse, successResponse } = require("../helpers/generalResponse");
const documentService = require("../services/documentService");

async function addDocument(req, res) {
  const result = await documentService.createDocument(req.auth.userId, req.body);
  console.log("req.body===", req.body);

  return successResponse(res, result, messageConstants.DOCUMENT_CREATED, StatusCodes.CREATED);
}

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

module.exports = {
  addDocument,
  deleteDocument,
  getDocumentById,
  getDocumentList,
  listDocuments,
  listDocumentsPaginated,
  getDownloadFile,
  deleteFile,
};
