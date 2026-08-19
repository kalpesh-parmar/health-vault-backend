const express = require("express");
const controller = require("../controllers/sse.controller");

const router = express.Router();

router.get("/:fileKey/stream", controller.streamFile);
router.get("/batches/:batchId/stream", controller.streamBatch);
router.get("/stats", controller.stats);

module.exports = router;
