const { StatusCodes } = require("http-status-codes");

const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const sessionService = require("../services/sessionService");

async function createSession(req, res) {
  const result = await sessionService.createSession(req.auth.userId, req.body);
  return successResponse(res, result, messageConstants.SESSION_CREATED, StatusCodes.CREATED);
}

async function getSessionById(req, res) {
  const result = await sessionService.getSessionById(req.params.id);
  return successResponse(res, result, messageConstants.SESSION_FETCHED);
}

module.exports = {
  createSession,
  getSessionById,
};
