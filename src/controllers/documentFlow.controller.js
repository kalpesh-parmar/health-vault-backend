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
const documentOcrJobService = require("../services/documentOcrJob.service");
const documentPersistenceService = require("../services/documentPersistence.service");
const ocrProgressBus = require("../services/sse/ocrProgressBus");
const { validateSchema } = require("../validations");
const {
  addDocumentSchema,
  fileKeySchema,
  batchFileKeySchema,
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
  const userId = req.auth.userId;
  const jobs = [];

  // 1. Handle legacy single fileKey
  if (data.fileKey) {
    const job = await documentOcrJobService.enqueue({
      fileKey: data.fileKey,
      mimeType: data.mimeType,
      userId,
    });
    jobs.push(job);
  }

  // 2. Handle array of fileKeys
  if (data.fileKeys && data.fileKeys.length > 0) {
    for (const fKey of data.fileKeys) {
      // avoid duplicate if fileKey was also provided
      if (fKey === data.fileKey) continue;
      const job = await documentOcrJobService.enqueue({
        fileKey: fKey,
        userId,
      });
      jobs.push(job);
    }
  }

  if (jobs.length === 0) {
    return res.status(StatusCodes.BAD_REQUEST).json({ error: "No fileKeys provided." });
  }

  // If only one job and no array format was used, return legacy single-object format
  if (jobs.length === 1 && !data.fileKeys) {
    return successResponse(
      res,
      {
        fileKey: jobs[0].fileKey,
        jobId: jobs[0].id,
        stage: jobs[0].stage,
        status: "OCR_STARTED",
      },
      "OCR job accepted",
      StatusCodes.ACCEPTED,
    );
  }

  const responseData = jobs.map((job) => ({
    fileKey: job.fileKey,
    jobId: job.id,
    stage: job.stage,
    status: "OCR_STARTED",
  }));

  return successResponse(res, responseData, "OCR jobs accepted", StatusCodes.ACCEPTED);
}

function formatJobStatusPayload(job) {
  if (!job) return null;
  const isFailed = job.status === "FAILED" || job.status === "REJECTED";
  const isCompleted = job.status === "COMPLETED";
  const stageStatus =
    job.stageStatus || (isFailed ? "FAILED" : isCompleted ? "COMPLETED" : "IN_PROGRESS");
  const percentage = job.percentage ?? (isCompleted ? 100 : 0);
  const status = isFailed ? "FAILED" : "SUCCESS";
  const message =
    job.message ||
    (isFailed
      ? job.error || "Document processing failed"
      : isCompleted
        ? "Processing completed"
        : `Processing ${job.stage || "document"}...`);

  return {
    processName: "document_processing",
    fileKey: job.fileKey,
    documentId: job.checkpointData?.documentId || null,
    fileName: job.metadata?.originalName || job.fileKey.split("/").pop(),
    batchId: job.metadata?.batchId || null,
    patientId: job.userId,
    stage: job.stage || (isCompleted ? "COMPLETED" : "QUEUED"),
    stageStatus,
    progress: percentage,
    percentage,
    status,
    message,
    attemptCount: job.attemptCount || 0,
    completedStages: job.completedStages || [],
    retryable:
      job.retryable !== undefined ? job.retryable : isFailed ? job.status !== "REJECTED" : true,
    requiresReupload: job.requiresReupload || false,
    failedStage: isFailed ? job.stage || null : null,
    resumeStage: job.stage || "QUEUED",
    checkpointData: job.checkpointData || {},
    rawOcrData: job.rawOcrData || null,
    extractedStructuredData: job.extractedStructuredData || null,
    graphs: job.graphs || [],
    summary:
      job.extractedStructuredData?.summaryInPreferredLanguage ||
      job.extractedStructuredData?.summaryEnglish ||
      "",
    error: job.error || null,
    startedAt: job.startedAt,
    completedAt: job.completedAt,
    lastHeartbeatAt: job.lastHeartbeatAt,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}

/**
 * Polling fallback for clients that lose the SSE connection. Returns the
 * latest job state including the final extraction payload once
 * status === COMPLETED.
 */
async function runOcrStatus(req, res) {
  const fileKey = req.params?.fileKey || req.query?.fileKey;
  if (!fileKey && req.query?.fileKeys) {
    const rawKeys = Array.isArray(req.query.fileKeys)
      ? req.query.fileKeys
      : String(req.query.fileKeys)
          .split(",")
          .map((k) => k.trim())
          .filter(Boolean);
    const jobs = await Promise.all(
      rawKeys.map(async (key) => {
        const job = await documentOcrJobService.getStatus({
          fileKey: key,
          userId: req.auth.userId,
        });
        return job ? formatJobStatusPayload(job) : { fileKey: key, status: "NOT_FOUND" };
      }),
    );
    return successResponse(res, jobs, "Document batch statuses fetched");
  }

  const { fileKey: validatedKey } = await validateSchema(fileKeySchema, { fileKey });
  const job = await documentOcrJobService.getStatus({
    fileKey: validatedKey,
    userId: req.auth.userId,
  });
  if (!job) throw new NotFoundException("Document job not found for this fileKey");

  const formatted = formatJobStatusPayload(job);
  return successResponse(res, formatted, "Document job status fetched");
}

/**
 * Fetch status for multiple files simultaneously
 */
async function runOcrStatusBatch(req, res) {
  const { fileKeys } = await validateSchema(batchFileKeySchema, req.body);
  const userId = req.auth.userId;

  const jobs = await Promise.all(
    fileKeys.map(async (fileKey) => {
      try {
        const job = await documentOcrJobService.getStatus({ fileKey, userId });
        if (!job) return { fileKey, status: "NOT_FOUND" };
        return formatJobStatusPayload(job);
      } catch (err) {
        return { fileKey, status: "ERROR", error: err.message };
      }
    }),
  );

  return successResponse(res, jobs, "OCR batch statuses fetched");
}
async function addDocument(req, res) {
  const payload = await validateSchema(addDocumentSchema, req.body);
  const result = await documentPersistenceService.addDocument({
    payload,
    userId: req.auth.userId,
  });
  return successResponse(res, result, messageConstants.DOCUMENT_CREATED, StatusCodes.CREATED);
}

module.exports = {
  addDocument,
  ocrProgressStream,
  runOcr,
  runOcrStatus,
  runOcrStatusBatch,
};
