const cronService = require("../services/cronService");
const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");

async function runReminder(req, res) {
  const result = await cronService.register();
  return successResponse(res, result, messageConstants.REMINDER_SENT);
}
async function cronStart(req, res) {
  const { key, expression } = req.body;
  const result = await cronService.start(key, expression);
  return successResponse(res, result, messageConstants.CRON_STARTED);
}
async function cronStop(req, res) {
  const result = await cronService.stop(req.body);
  return successResponse(res, result, messageConstants.CRON_STOPPED);
}
async function cronStartAll(req, res) {
  const result = await cronService.startAll(req.body);
  return successResponse(res, result, messageConstants.CRON_STARTED_ALL);
}
async function cronList(req, res) {
  const result = await cronService.list();
  return successResponse(res, result, messageConstants.CRON_LIST);
}
module.exports = {
  runReminder,
  cronStart,
  cronStop,
  cronStartAll,
  cronList,
};
