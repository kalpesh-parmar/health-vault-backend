const { StatusCodes } = require("http-status-codes");

const { successResponse } = require("../helpers/generalResponse");
const ocrService = require("../services/ocr.service");

async function ocrExtract(req, res) {
  const result = await ocrService.ocrExtract(req.auth?.userId, req.file);
  return successResponse(res, result, "Document processing started", StatusCodes.ACCEPTED);
}

async function getOcrStatus(req, res) {
  const result = await ocrService.getOcrStatus(req.auth?.userId, req.params.documentId);
  return successResponse(res, result);
}

async function cancelOcr(req, res) {
  const result = await ocrService.cancelOcr(req.auth?.userId, req.params.documentId);
  return successResponse(res, result, "Job cancelled successfully");
}

async function onboardingChat(req, res) {
  const result = await ocrService.onboardingChat(req.auth?.userId, req.body);
  return successResponse(res, result);
}

async function getOnboardingStatus(req, res) {
  const result = await ocrService.getOnboardingStatus(req.auth?.userId);
  return successResponse(res, result);
}

async function getOnboardingHistory(req, res) {
  const result = await ocrService.getOnboardingHistory(req.auth?.userId);
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
