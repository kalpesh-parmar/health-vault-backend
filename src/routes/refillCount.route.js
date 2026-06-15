const express = require("express");
const { verifyToken } = require("../middlewares/authMiddleware");
const refillController = require("../controllers/refill.controller");
const router = express.Router();

router.get("/list", verifyToken, refillController.getRefillList);
router.post("/list-pagination", verifyToken, refillController.getRefillListPagination);
router.get("/badge-count", verifyToken, refillController.badgeCount);

module.exports = router;
