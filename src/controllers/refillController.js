const { messageConstants } = require("../constants/messageConstants");
const { successResponse, paginatedSuccessResponse } = require("../helpers/generalResponse");
const refillService = require("../services/refillService");

async function badgeCount(req, res) {
  const { medicationId } = req.query;
  const result = await refillService.badgeCount(medicationId);
  return successResponse(res, result, messageConstants.REFILL_BADGE_COUNT_FETCH);
}

async function getRefillList(req, res) {
  const result = await refillService.getRefillList(req.auth.userId);
  return successResponse(res, result, messageConstants.REFILL_BADGE_COUNT_FETCH);
}

async function getRefillListPagination(req, res) {
  const result = await refillService.getRefillListPagination(req.body, req.auth.userId);

  return paginatedSuccessResponse(
    res,
    result.record,
    result.pagination,
    messageConstants.REFILL_FILTERED_LIST_FETCHED,
  );
}

module.exports = {
  badgeCount,
  getRefillList,
  getRefillListPagination,
};
