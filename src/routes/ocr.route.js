const express = require("express");
const { verifyToken } = require("../middlewares/authMiddleware.js");
const ocrController = require("../controllers/ocr.controller.js");
const { upload } = require("../middlewares/upload.js");
const router = express.Router();

router.post("/ocr/extract", verifyToken, upload.single("file"), ocrController.ocrExtract);
router.get("/ocr/status/:documentId", verifyToken, ocrController.getOcrStatus);
router.post("/ocr/cancel/:documentId", verifyToken, ocrController.cancelOcr);
router.post("/onboarding/chat", verifyToken, ocrController.onboardingChat);
router.get("/onboarding/status", verifyToken, ocrController.getOnboardingStatus);
router.get("/onboarding/history", verifyToken, ocrController.getOnboardingHistory);

module.exports = router;
