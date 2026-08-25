const { StatusCodes } = require("http-status-codes");
const { AbortController } = global;
const { messageConstants } = require("../constants/messageConstants");
const { paginatedSuccessResponse, successResponse } = require("../helpers/generalResponse");
const { chatService } = require("../services/ai");
const { validateSchema } = require("../validations");
const {
  createChatSessionSchema,
  sendChatMessageSchema,
  sessionListQuerySchema,
  sessionMessagesQuerySchema,
} = require("../validations/documentFlowValidation");

async function createSession(req, res) {
  const data = await validateSchema(createChatSessionSchema, req.body);
  const session = await chatService.createSession({ ...data, userId: req.auth.userId });

  if (session && "documentId" in session) {
    delete session.documentId;
  }

  return successResponse(res, session, messageConstants.SESSION_CREATED, StatusCodes.CREATED);
}

async function listSessions(req, res) {
  const data = await validateSchema(sessionListQuerySchema, req.query);
  const result = await chatService.listSessions({ ...data, userId: req.auth.userId });

  const mappedItems = result.items.map((session) => {
    if ("documentId" in session) {
      return { ...session, documentId: undefined };
    }
    return session;
  });

  return paginatedSuccessResponse(
    res,
    mappedItems,
    { nextCursor: result.nextCursor },
    messageConstants.SESSION_FETCHED,
  );
}

async function listMessages(req, res) {
  const data = await validateSchema(sessionMessagesQuerySchema, req.query);
  const result = await chatService.listMessages({
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

  if (data.stream === true) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");

    res.flush = () => {};
    req.socket.setTimeout(0);
    if (typeof res.flushHeaders === "function") res.flushHeaders();

    const abortController = new AbortController();
    req.on("close", () => {
      abortController.abort();
    });

    const onChunk = (chunk) => {
      if (!res.writableEnded && chunk) {
        res.write(`data: ${JSON.stringify({ type: "chunk", text: chunk })}\n\n`);
        if (typeof res.flush === "function") res.flush();
      }
    };

    try {
      const result = await chatService.sendMessage({
        ...data,
        userId: req.auth.userId,
        onChunk,
        abortSignal: abortController.signal,
      });

      if (!res.writableEnded) {
        res.write(`data: ${JSON.stringify({ type: "final", data: result })}\n\n`);
        res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      }
      return res.end();
    } catch (error) {
      if (!res.headersSent) {
        throw error;
      }
      if (!res.writableEnded && error.name !== "AbortError" && error.code !== "ERR_CANCELED") {
        res.write(
          `data: ${JSON.stringify({ type: "error", message: error.message || "Internal Server Error" })}\n\n`,
        );
      }
      return res.end();
    }
  }

  const result = await chatService.sendMessage({ ...data, userId: req.auth.userId });
  if (result && result.requireSelection) {
    return successResponse(
      res,
      result,
      messageConstants.DOCUMENT_SELECTION_REQUIRED,
      StatusCodes.OK,
    );
  }

  return successResponse(res, result, messageConstants.SUMMARY_CREATED, StatusCodes.CREATED);
}

async function deleteSession(req, res) {
  const result = await chatService.deleteSession({
    sessionId: req.params.id,
    userId: req.auth.userId,
  });
  return successResponse(res, result, "Session deleted");
}

module.exports = { createSession, deleteSession, listMessages, listSessions, sendMessage };
