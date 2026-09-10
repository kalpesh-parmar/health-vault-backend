const express = require("express");
const dashboardController = require("../controllers/dashboard.controller");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/summary", verifyToken, dashboardController.getSummaryCount);

module.exports = router;
