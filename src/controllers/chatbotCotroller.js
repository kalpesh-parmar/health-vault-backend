const { StatusCodes } = require("http-status-codes");

const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const chatbotService = require("../services/chatbotService");

async function createSummary(req, res) {
  const result = await chatbotService.generateSummary(req.auth.userId, req.body);
  return successResponse(res, result, messageConstants.SUMMARY_CREATED, StatusCodes.CREATED);
}

module.exports = {
  createSummary,
};
