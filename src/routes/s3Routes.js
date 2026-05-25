const express = require("express");

const s3Controller = require("../controllers/s3Controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const { upload } = require("../middlewares/upload");

const router = express.Router();

router.post("/upload", upload.single("file"), s3Controller.uploadFile);
router.get("/getUrl", verifyToken, s3Controller.getSignedUrl);
router.delete("/hard-delete", verifyToken, s3Controller.deleteFile);

module.exports = router;
