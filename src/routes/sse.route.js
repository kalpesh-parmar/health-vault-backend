const express = require("express");
const controller = require("../controllers/sse.controller");

const router = express.Router();

router.get("/files/:fileKey/stream", controller.streamFile);
router.get("/batches/:batchId/stream", controller.streamBatch);
router.get("/stats", controller.stats);

module.exports = router;
