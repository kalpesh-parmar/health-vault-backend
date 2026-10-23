const { successResponse } = require("../helpers/generalResponse");
const { messageConstants } = require("../constants/messageConstants");
const medicationAdherenceService = require("../services/medicationAdherence.service");

async function getWeeklyAdherence(req, res) {
  const result = await medicationAdherenceService.getWeeklyAdherence(req.auth.userId, req.query);
  return successResponse(res, result, messageConstants.WEEKLY_ADHERENCE_FETCHED);
}

async function getMonthlyAdherence(req, res) {
  const result = await medicationAdherenceService.getMonthlyAdherence(req.auth.userId, req.query);
  return successResponse(res, result, messageConstants.MONTHLY_ADHERENCE_FETCHED);
}

async function getDailyDetails(req, res) {
  const result = await medicationAdherenceService.getDailyDetails(req.auth.userId, req.query);
  return successResponse(res, result, messageConstants.DAILY_DETAILS_FETCHED);
}

async function getRefillAlerts(req, res) {
  const result = await medicationAdherenceService.getRefillAlerts(req.auth.userId, req.query);
  return successResponse(res, result, messageConstants.REFILL_ALERTS_FETCHED);
}

module.exports = {
  getWeeklyAdherence,
  getMonthlyAdherence,
  getDailyDetails,
  getRefillAlerts,
};
