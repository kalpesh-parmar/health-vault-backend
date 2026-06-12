const { StatusCodes } = require("http-status-codes");

const { messageConstants } = require("../constants/messageConstants");
const { paginatedSuccessResponse, successResponse } = require("../helpers/generalResponse");
const documentChatService = require("../services/aiService/documentChatService");
const { validateSchema } = require("../validations");
const {
  createChatSessionSchema,
  sendChatMessageSchema,
  sessionListQuerySchema,
  sessionMessagesQuerySchema,
} = require("../validations/documentFlowValidation");

async function createSession(req, res) {
  const data = await validateSchema(createChatSessionSchema, req.body);
  const session = await documentChatService.createSession({ ...data, userId: req.auth.userId });
  return successResponse(res, session, messageConstants.SESSION_CREATED, StatusCodes.CREATED);
}

async function listSessions(req, res) {
  const data = await validateSchema(sessionListQuerySchema, req.query);
  const result = await documentChatService.listSessions({ ...data, userId: req.auth.userId });
  return paginatedSuccessResponse(
    res,
    result.items,
    { nextCursor: result.nextCursor },
    messageConstants.SESSION_FETCHED,
  );
}

async function listMessages(req, res) {
  const data = await validateSchema(sessionMessagesQuerySchema, req.query);
  const result = await documentChatService.listMessages({
    ...data,
    sessionId: req.params.id,
    userId: req.auth.userId,
  });
  return paginatedSuccessResponse(
    res,
    result.items,
    { nextCursor: result.nextCursor },
    "Messages fetched",
  );
}

async function sendMessage(req, res) {
  const data = await validateSchema(sendChatMessageSchema, req.body);
  const result = await documentChatService.sendMessage({ ...data, userId: req.auth.userId });
  return successResponse(res, result, messageConstants.SUMMARY_CREATED, StatusCodes.CREATED);
}

async function deleteSession(req, res) {
  const result = await documentChatService.deleteSession({
    sessionId: req.params.id,
    userId: req.auth.userId,
  });
  return successResponse(res, result, "Session deleted");
}

module.exports = { createSession, deleteSession, listMessages, listSessions, sendMessage };
