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
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    // Bypass compression middleware for this specific SSE response
    res.flush = () => {};
    req.socket.setTimeout(0);
    // Optionally flush headers if a middleware like compression is used
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    // eslint-disable-next-line no-undef
    const abortController = new AbortController();
    req.on("close", () => {
      abortController.abort();
    });

    //seend token to frontend for streaming
    // STREAMING TEST ONLY
    const sseStartTime = Date.now();
    let sseChunkCount = 0;

    const onChunk = (chunk) => {
      if (!res.writableEnded) {
        sseChunkCount++;
        // STREAMING TEST ONLY
        if (sseChunkCount === 1) {
          // eslint-disable-next-line no-console
          console.log(`[STREAM TEST] FIRST SSE CHUNK SENT after ${Date.now() - sseStartTime}ms`);
        } else if (sseChunkCount % 50 === 0) {
          // eslint-disable-next-line no-console
          console.log(
            `[STREAM TEST] SSE CHUNK #${sseChunkCount} SENT after ${Date.now() - sseStartTime}ms`,
          );
        }

        res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
        if (typeof res.flush === "function") res.flush(); //foorce the data to go the frontend imediately
      }
    };

    try {
      const result = await ocrService.onboardingChat(
        req.auth?.userId,
        req.body,
        onChunk,
        abortController.signal,
      );
      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "final", data: result })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
        // STREAMING TEST ONLY
        // eslint-disable-next-line no-console
        console.log(`[STREAM TEST] SSE STREAM COMPLETE after ${Date.now() - sseStartTime}ms`);
      }
      return res.end();
    } catch (error) {
      if (!res.headersSent) {
        throw error;
      }
      if (!res.writableEnded && error.name !== "AbortError" && error.code !== "ERR_CANCELED") {
        res.write(
          `data: ${JSON.stringify({ type: "error", message: error.message || "Internal Server Error" })}\n\n`,
        );
      }
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
