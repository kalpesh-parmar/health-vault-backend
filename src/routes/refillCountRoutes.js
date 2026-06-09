const express = require("express");
const { verifyToken } = require("../middlewares/authMiddleware");
const refillController = require("../controllers/refillController");
const router = express.Router();

router.get("/badge-count/:medicationId", verifyToken, refillController.badgeCount);
router.get("/list", verifyToken, refillController.getRefillList);
router.post("/list-pagination", verifyToken, refillController.getRefillListPagination);

module.exports = router;
