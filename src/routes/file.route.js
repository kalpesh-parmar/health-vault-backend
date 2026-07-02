const express = require("express");

const fileController = require("../controllers/file.controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const { upload } = require("../middlewares/upload");

const router = express.Router();

router.post(
  "/upload",
  upload.fields([
    { name: "file", maxCount: 1 },
    { name: "files", maxCount: 5 },
  ]),
  fileController.uploadFile,
);
router.get("/view", verifyToken, fileController.viewFile);
router.delete("/hard-delete", verifyToken, fileController.deleteFile);

module.exports = router;
