const express = require("express");

const documentController = require("../controllers/documentController");
const {
  scopeDocumentFilterToAuthenticatedUser,
} = require("../middlewares/documentScopeMiddleware");
const { verifyToken } = require("../middlewares/authMiddleware");
const { validateRequest } = require("../middlewares/validateRequest");
const { createDocumentSchema } = require("../validations");

const router = express.Router();

router.post(
  "/add",
  verifyToken,
  validateRequest({ body: createDocumentSchema }),
  documentController.addDocument,
);
router.post(
  "/list",
  verifyToken,
  scopeDocumentFilterToAuthenticatedUser,
  documentController.listDocuments,
);
router.post(
  "/list-paginated",
  verifyToken,
  scopeDocumentFilterToAuthenticatedUser,
  documentController.listDocumentsPaginated,
);
router.get("/list", verifyToken, documentController.getDocumentList);
router.get("/:id", verifyToken, documentController.getDocumentById);
router.delete("/:id", verifyToken, documentController.deleteDocument);

module.exports = router;
