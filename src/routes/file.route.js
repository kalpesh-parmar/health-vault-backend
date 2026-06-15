const express = require("express");

const fileController = require("../controllers/file.controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const { upload } = require("../middlewares/upload");

const router = express.Router();

router.post("/upload", upload.single("file"), fileController.uploadFile);
router.get("/view", verifyToken, fileController.viewFile);
router.delete("/hard-delete", verifyToken, fileController.deleteFile);

module.exports = router;
