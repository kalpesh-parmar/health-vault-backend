const express = require("express");
const { verifyToken } = require("../middlewares/authMiddleware");
const refillController = require("../controllers/refillController");
const router = express.Router();

router.get("/badge-count/:medicationId", verifyToken, refillController.badgeCount);

module.exports = router;
