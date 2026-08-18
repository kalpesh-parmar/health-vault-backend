const express = require("express");
const { verifyToken } = require("../middlewares/authMiddleware.js");
const ocrController = require("../controllers/ocr.controller.js");
const { upload } = require("../middlewares/upload.js");
const { validateRequest } = require("../middlewares/validateRequest");
const { unifiedChatSchema } = require("../validations/documentFlowValidation");
const router = express.Router();

router.post("/ocr/extract", verifyToken, upload.single("file"), ocrController.ocrExtract);
router.get("/ocr/status/:documentId", verifyToken, ocrController.getOcrStatus);
router.post("/ocr/cancel/:documentId", verifyToken, ocrController.cancelOcr);

/* BACKUP OF PREVIOUS ROUTE DEFINITION:
router.post("/onboarding/chat", verifyToken, ocrController.onboardingChat);
*/
router.post(
  "/onboarding/chat",
  verifyToken,
  validateRequest({ body: unifiedChatSchema }),
  ocrController.onboardingChat,
);

router.get("/onboarding/status", verifyToken, ocrController.getOnboardingStatus);
router.get("/onboarding/history", verifyToken, ocrController.getOnboardingHistory);

module.exports = router;
