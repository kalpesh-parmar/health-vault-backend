const express = require("express");

const s3Controller = require("../controllers/s3Controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const { upload } = require("../middlewares/upload");

const router = express.Router();

router.post("/upload", upload.single("profilePicture"), s3Controller.uploadFile);
router.delete("/delete", verifyToken, s3Controller.fileDelete);
router.get("/get-url", verifyToken, s3Controller.getSignedUrl);

module.exports = router;
