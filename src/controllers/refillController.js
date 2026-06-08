const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const refillService = require("../services/refillService");

async function badgeCount(req, res) {
  const result = await refillService.badgeCount(req.params);
  return successResponse(res, result, messageConstants.NOTIFICATION_BADGE_COUNT_FETCHED);
}

module.exports = {
  badgeCount,
};
