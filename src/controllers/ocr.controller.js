const { StatusCodes } = require("http-status-codes");

const { successResponse } = require("../helpers/generalResponse");
const v1Service = require("../services/ocr.service");

async function ocrExtract(req, res) {
  const result = await v1Service.ocrExtract(req.auth?.userId, req.file);
  return successResponse(res, result, "Document processing started", StatusCodes.ACCEPTED);
}

async function getOcrStatus(req, res) {
  const result = await v1Service.getOcrStatus(req.auth?.userId, req.params.documentId);
  return successResponse(res, result);
}

async function cancelOcr(req, res) {
  const result = await v1Service.cancelOcr(req.auth?.userId, req.params.documentId);
  return successResponse(res, result, "Job cancelled successfully");
}

async function onboardingChat(req, res) {
  const result = await v1Service.onboardingChat(req.auth?.userId, req.body);
  return successResponse(res, result);
}

async function getOnboardingStatus(req, res) {
  const result = await v1Service.getOnboardingStatus(req.auth?.userId);
  return successResponse(res, result);
}

async function getOnboardingHistory(req, res) {
  const result = await v1Service.getOnboardingHistory(req.auth?.userId);
  return successResponse(res, result);
}

module.exports = {
  ocrExtract,
  getOcrStatus,
  cancelOcr,
  onboardingChat,
  getOnboardingStatus,
  getOnboardingHistory,
};
