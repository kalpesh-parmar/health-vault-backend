const { messageConstants } = require("../constants/messageConstants");
const { paginatedSuccessResponse, successResponse } = require("../helpers/generalResponse");
const notificationApiService = require("../services/notificationApiService");

async function testSend(req, res) {
  const result = await notificationApiService.testSend(req.body);
  return successResponse(res, result, messageConstants.NOTIFICATION_SENT);
}

async function list(req, res) {
  const result = await notificationApiService.list(req.body);
  return successResponse(res, result, messageConstants.NOTIFICATION_LIST_FETCHED);
}

async function listPaginated(req, res) {
  const result = await notificationApiService.listPaginated(req.body);
  return paginatedSuccessResponse(
    res,
    result.data,
    result.page,
    messageConstants.NOTIFICATION_LIST_FETCHED,
  );
}

async function markRead(req, res) {
  const result = await notificationApiService.markRead(req.params);
  return successResponse(res, result, messageConstants.NOTIFICATION_MARKED_READ);
}

async function markAllRead(req, res) {
  const result = await notificationApiService.markAllRead(req.body);
  return successResponse(res, result, messageConstants.NOTIFICATION_MARKED_ALL_READ);
}

async function deleteNotification(req, res) {
  const result = await notificationApiService.delete(req.params);
  return successResponse(res, result, messageConstants.NOTIFICATION_DELETED);
}

async function badgeCount(req, res) {
  const result = await notificationApiService.badgeCount(req.body);
  return successResponse(res, result, messageConstants.NOTIFICATION_BADGE_COUNT_FETCHED);
}

module.exports = {
  badgeCount,
  deleteNotification,
  list,
  listPaginated,
  markAllRead,
  markRead,
  testSend,
};
