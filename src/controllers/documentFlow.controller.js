/**
 * Controllers for the upload → SSE → run-ocr → add flow.
 *
 *  • POST /documents/upload                — multipart upload, GCS only
 *  • GET  /documents/ocr-progress/:fileKey — SSE channel
 *  • POST /documents/run-ocr               — non-blocking; returns 202
 *  • GET  /documents/run-ocr-status/:fileKey — read latest job state
 *  • POST /documents/add                   — persist FE-confirmed data
 */

const { StatusCodes } = require("http-status-codes");

const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const { attachSseStream } = require("../services/sse/sseTransport");
const { NotFoundException } = require("../exceptions/appError");
const documentOcrJobService = require("../services/documentOcrJobService");
const documentPersistenceService = require("../services/documentPersistenceService");
const ocrProgressBus = require("../services/sse/ocrProgressBus");
const { validateSchema } = require("../validations");
const {
  addDocumentSchema,
  fileKeySchema,
  runOcrSchema,
} = require("../validations/documentFlowValidation");

async function ocrProgressStream(req, res) {
  const { fileKey } = await validateSchema(fileKeySchema, req.params);
  const stream = attachSseStream(req, res);
  const unsubscribe = ocrProgressBus.subscribe(fileKey, (event) => stream.write(event));
  res.on("close", () => unsubscribe());
}

/**
 * Non-blocking enqueue. Returns 202 Accepted with the job id and an
 * "OCR_STARTED" status. The actual pipeline runs via setImmediate inside
 * `documentOcrJobService.enqueue`.
 */
async function runOcr(req, res) {
  const data = await validateSchema(runOcrSchema, req.body);
  const job = await documentOcrJobService.enqueue({
    fileKey: data.fileKey,
    mimeType: data.mimeType,
    userId: req.auth.userId,
  });

  return successResponse(
    res,
    {
      fileKey: job.fileKey,
      jobId: job.id,
      stage: job.stage,
      status: "OCR_STARTED",
    },
    "OCR job accepted",
    StatusCodes.ACCEPTED,
  );
}

/**
 * Polling fallback for clients that lose the SSE connection. Returns the
 * latest job state including the final extraction payload once
 * status === COMPLETED.
 */
async function runOcrStatus(req, res) {
  const { fileKey } = await validateSchema(fileKeySchema, req.params);
  const job = await documentOcrJobService.getStatus({ fileKey, userId: req.auth.userId });
  if (!job) throw new NotFoundException("OCR job not found for this fileKey");

  if (job.status === "FAILED") {
    return res.status(StatusCodes.OK).json({
      status: "FAILED",
      error: job.error || "AI response format is invalid.",
    });
  }

  return successResponse(res, job, "OCR job status fetched");
}

async function addDocument(req, res) {
  const payload = await validateSchema(addDocumentSchema, req.body);
  const result = await documentPersistenceService.addDocument({
    payload,
    userId: req.auth.userId,
  });
  return successResponse(res, result, messageConstants.DOCUMENT_CREATED, StatusCodes.CREATED);
}

module.exports = { addDocument, ocrProgressStream, runOcr, runOcrStatus };
