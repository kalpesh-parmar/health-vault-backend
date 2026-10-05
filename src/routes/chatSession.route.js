const express = require("express");

const chatSessionController = require("../controllers/chatSession.controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const { validateRequest } = require("../middlewares/validateRequest");
const {
  createChatSessionSchema,
  idParamSchema,
  sendChatMessageSchema,
  sessionListQuerySchema,
  sessionMessagesQuerySchema,
} = require("../validations/documentFlowValidation");

const router = express.Router();

router.post(
  "/session",
  verifyToken,
  validateRequest({ body: createChatSessionSchema }),
  chatSessionController.createSession,
);

router.get(
  "/session",
  verifyToken,
  validateRequest({ query: sessionListQuerySchema }),
  chatSessionController.listSessions,
);

router.get(
  "/session/:id/messages",
  verifyToken,
  validateRequest({ params: idParamSchema, query: sessionMessagesQuerySchema }),
  chatSessionController.listMessages,
);

router.delete(
  "/session/:id",
  verifyToken,
  validateRequest({ params: idParamSchema }),
  chatSessionController.deleteSession,
);

router.post(
  "/message",
  verifyToken,
  validateRequest({ body: sendChatMessageSchema }),
  chatSessionController.sendMessage,
);

module.exports = router;
