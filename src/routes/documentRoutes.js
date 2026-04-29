const express = require("express");

const documentController = require("../controllers/documentController");
const { verifyToken } = require("../middlewares/authMiddleware");
// const { validateRequest } = require("../middlewares/validateRequest");
// const { createDocumentSchema } = require("../validations");
const { upload, validateFile } = require("../middlewares/upload");

const router = express.Router();

router.post(
  "/add",
  upload.single("file"),
  verifyToken,
  validateFile,
  documentController.addDocument,
);
router.post("/list", verifyToken, documentController.listDocuments);
router.post("/list-paginated", verifyToken, documentController.listDocumentsPaginated);
router.get("/list", verifyToken, documentController.getDocumentList);
router.get("/:id", verifyToken, documentController.getDocumentById);
router.delete("/:id", verifyToken, documentController.deleteDocument);

//document upload in s3 bucket
// router.post(
//   "/upload",
//   upload.single("file"),
//   validateFile,
//   FileController.uploadFile,
// );

//download document from s3 bucket using file key
// router.get("/download-url", FileController.getDownloadFile);

//delete document from s3 bucket using file key
// router.delete("/delete", FileController.deleteFile);

module.exports = router;
