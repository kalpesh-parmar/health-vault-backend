const express = require("express");
const controller = require("../controllers/sse.controller");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/files/:fileKey/stream", verifyToken, controller.streamFile);
router.get("/batches/:batchId/stream", verifyToken, controller.streamBatch);
router.get("/stats", verifyToken, controller.stats);

module.exports = router;
