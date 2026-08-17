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
  if (req.body?.stream === true || req.body?.stream === "true") {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    // Optionally flush headers if a middleware like compression is used
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const onChunk = (chunk) => {
      res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
      if (typeof res.flush === "function") res.flush();
    };

    try {
      const result = await ocrService.onboardingChat(req.auth?.userId, req.body, onChunk);
      res.write(`data: ${JSON.stringify({ type: "final", data: result })}\n\n`);
      return res.end();
    } catch (error) {
      if (!res.headersSent) {
        throw error;
      }
      res.write(
        `data: ${JSON.stringify({ type: "error", message: error.message || "Internal Server Error" })}\n\n`,
      );
      return res.end();
    }
  } else {
    const result = await ocrService.onboardingChat(req.auth?.userId, req.body);
    return successResponse(res, result);
  }
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
