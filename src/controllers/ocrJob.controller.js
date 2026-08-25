const { StatusCodes } = require("http-status-codes");
const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const documentOcrJobService = require("../services/documentOcrJob.service");

async function startJob(req, res) {
  const job = await documentOcrJobService.startJobById(req.params.jobId, req.auth.userId);
  return successResponse(
    res,
    {
      jobId: job.id,
      fileKey: job.fileKey,
      status: "OCR_STARTED",
      stage: job.stage,
    },
    "OCR job started",
    StatusCodes.ACCEPTED,
  );
}

async function startBatchJobs(req, res) {
  const result = await documentOcrJobService.startBatchJobs(req.body.jobIds, req.auth.userId);
  return successResponse(
    res,
    result,
    messageConstants.BATCH_OCR_JOBS_STARTED,
    StatusCodes.ACCEPTED,
  );
}

async function getJobStatus(req, res) {
  const job = await documentOcrJobService.getJobById(req.params.jobId, req.auth.userId);
  return successResponse(res, job, "OCR job status fetched", StatusCodes.OK);
}

async function getBatchJobStatuses(req, res) {
  const results = await documentOcrJobService.getBatchJobStatuses(req.body.jobIds, req.auth.userId);
  return successResponse(
    res,
    results,
    messageConstants.BATCH_OCR_JOBS_STATUS_FETCHED,
    StatusCodes.OK,
  );
}

async function getJobResult(req, res) {
  const result = await documentOcrJobService.getJobResult(req.params.jobId, req.auth.userId);
  return successResponse(res, result, "OCR job result fetched", StatusCodes.OK);
}

module.exports = {
  startJob,
  startBatchJobs,
  getJobStatus,
  getBatchJobStatuses,
  getJobResult,
};
