const express = require("express");

const { verifyToken } = require("../middlewares/authMiddleware");
const chatbotController = require("../controllers/chatbotCotroller");

const router = express.Router();

router.post("/summary", verifyToken, chatbotController.createSummary);

module.exports = router;
