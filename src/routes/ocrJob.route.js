const express = require("express");
const ocrJobController = require("../controllers/ocrJob.controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const { validateJobIdParam, validateBatchJobIdsBody } = require("../validations");

const router = express.Router();

router.post("/:jobId/start", verifyToken, validateJobIdParam, ocrJobController.startJob);
router.get("/:jobId", verifyToken, validateJobIdParam, ocrJobController.getJobStatus);
router.get("/:jobId/result", verifyToken, validateJobIdParam, ocrJobController.getJobResult);
router.post("/batch-start", verifyToken, validateBatchJobIdsBody, ocrJobController.startBatchJobs);
router.post(
  "/batch-status",
  verifyToken,
  validateBatchJobIdsBody,
  ocrJobController.getBatchJobStatuses,
);

module.exports = router;
