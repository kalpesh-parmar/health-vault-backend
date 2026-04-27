const express = require("express");
const router = express.Router();
const documentController = require("../controllers/documentController.js");

router.post("/add", documentController.addDocument);
router.get("/list", documentController.getDocumentList);
router.get("/:id", documentController.getDocumentById);
router.delete("/:id", documentController.deleteDocument);

module.exports = router;
