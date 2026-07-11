const express = require("express");
const { verifyToken } = require("../middlewares/authMiddleware.js");
const v1Controller = require("../controllers/v1.controller");
const { upload } = require("../middlewares/upload.js");
const router = express.Router();

router.post("/ocr/extract", verifyToken, upload.single("file"), v1Controller.ocrExtract);
router.get("/ocr/status/:documentId", verifyToken, v1Controller.getOcrStatus);
router.post("/ocr/cancel/:documentId", verifyToken, v1Controller.cancelOcr);
router.post("/onboarding/chat", verifyToken, v1Controller.onboardingChat);
router.get("/onboarding/status", verifyToken, v1Controller.getOnboardingStatus);

module.exports = router;
