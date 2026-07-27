const express = require("express");
const ocrJobController = require("../controllers/ocrJob.controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const { validateJobIdParam } = require("../validations");

const router = express.Router();

router.post("/:jobId/start", verifyToken, validateJobIdParam, ocrJobController.startJob);
router.get("/:jobId", verifyToken, validateJobIdParam, ocrJobController.getJobStatus);
router.get("/:jobId/result", verifyToken, validateJobIdParam, ocrJobController.getJobResult);

module.exports = router;
