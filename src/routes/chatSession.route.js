const express = require("express");

const chatSessionController = require("../controllers/chatSession.controller");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/session", verifyToken, chatSessionController.createSession);
router.get("/session", verifyToken, chatSessionController.listSessions);
router.get("/session/:id/messages", verifyToken, chatSessionController.listMessages);
router.delete("/session/:id", verifyToken, chatSessionController.deleteSession);
router.post("/message", verifyToken, chatSessionController.sendMessage);

module.exports = router;
