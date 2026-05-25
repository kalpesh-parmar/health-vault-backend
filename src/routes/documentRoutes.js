const express = require("express");

const documentController = require("../controllers/documentController");
const { verifyToken } = require("../middlewares/authMiddleware");
const { validateRequest } = require("../middlewares/validateRequest");
const { downloadFileQuerySchema } = require("../validations/documentValidation");

const router = express.Router();

router.post("/add", verifyToken, documentController.addDocument);

//download document from s3 bucket using file key
router.get(
  "/download-url",
  verifyToken,
  validateRequest(downloadFileQuerySchema),
  documentController.getDownloadFile,
);

// delete document from s3 bucket using file key
router.delete("/delete", verifyToken, documentController.deleteFile);
router.post("/list", verifyToken, documentController.listDocuments);
router.post("/list-paginated", verifyToken, documentController.listDocumentsPaginated);
router.get("/list", verifyToken, documentController.getDocumentList);
router.get("/:id", verifyToken, documentController.getDocumentById);
router.delete("/:id", verifyToken, documentController.deleteDocument);

module.exports = router;
