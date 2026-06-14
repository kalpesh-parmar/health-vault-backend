const express = require("express");

const documentController = require("../controllers/documentController");
const documentFlowController = require("../controllers/documentFlowController");
const { verifyToken } = require("../middlewares/authMiddleware");
const { upload } = require("../middlewares/upload");
const { validateRequest } = require("../middlewares/validateRequest");
const { downloadFileQuerySchema } = require("../validations/documentValidation");

const router = express.Router();

// ── Async OCR flow ───────────────────────────────────────────────────────
// 1. Upload only — no DB writes, no OCR. Returns fileKey + metadata.
router.post("/upload", verifyToken, upload.single("file"), documentFlowController.uploadDocument);

// 2. SSE channel keyed by fileKey. FE subscribes BEFORE calling /run-ocr.
router.get("/ocr-progress/:fileKey", verifyToken, documentFlowController.ocrProgressStream);

// 3. Non-blocking enqueue. Returns 202 in <100ms; pipeline runs in
//    background via setImmediate inside documentOcrJobService.
router.post("/run-ocr", verifyToken, documentFlowController.runOcr);

// 4. Polling fallback if the FE drops the SSE connection. Returns the
//    persisted job row including final extraction data when COMPLETED.
router.get("/run-ocr-status/:fileKey", verifyToken, documentFlowController.runOcrStatus);

// 5. Persist FE-confirmed extraction (no OCR/AI here).
router.post("/add", verifyToken, documentFlowController.addDocument);

// ── Document CRUD ─────────────────────────────────────────────────────────
router.get(
  "/download-url",
  verifyToken,
  validateRequest(downloadFileQuerySchema),
  documentController.getDownloadFile,
);

router.delete("/delete", verifyToken, documentController.deleteFile);
router.get("/", verifyToken, documentController.getDocumentList);
router.get("/:id", verifyToken, documentController.getDocumentById);
router.delete("/:id", verifyToken, documentController.deleteDocument);

// Legacy filter endpoints kept for backwards compatibility.
router.post("/list", verifyToken, documentController.listDocuments);
router.post("/list-paginated", verifyToken, documentController.listDocumentsPaginated);

module.exports = router;
