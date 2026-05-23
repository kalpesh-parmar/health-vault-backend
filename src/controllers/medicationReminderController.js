const { StatusCodes } = require("http-status-codes");
const { successResponse } = require("../helpers/generalResponse");
const { messageConstants } = require("../constants/messageConstants");
const medicationReminderService = require("../services/medicationReminderService");

// CREATE REMINDER
async function createReminder(req, res) {
  const result = await medicationReminderService.createReminder(req.auth.userId, req.body);

  return successResponse(
    res,
    result,
    messageConstants.MEDICATION_REMINDER_CREATED,
    StatusCodes.CREATED,
  );
}


// GET ALL REMINDERS
async function getAllReminders(req, res) {
  const result = await medicationReminderService.getAllReminders(req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_REMINDER_LIST_FETCHED);
}

// GET REMINDER BY ID
async function getReminderById(req, res) {
  const result = await medicationReminderService.getReminderById(req.params.id, req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_REMINDER_FETCHED);
}

// DELETE REMINDER
async function deleteReminder(req, res) {
  const result = await medicationReminderService.deleteReminder(req.params.id, req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_REMINDER_DELETED);
}

// GET TODAY OCCURRENCES
async function getTodayOccurrences(req, res) {
  const result = await medicationReminderService.getTodayOccurrences(req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_OCCURRENCES_FETCHED);
}

// COMPLETE REMINDER
async function completeReminder(req, res) {
  const result = await medicationReminderService.completeReminder(
    req.params.id,
    req.auth.userId,
    req.body,
  );

  return successResponse(res, result, messageConstants.MEDICATION_REMINDER_COMPLETED);
}


// MISSED REMINDER
async function missedReminder(req, res) {
  const result = await medicationReminderService.missedReminder(req.params.id, req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_REMINDER_MISSED);
}


// SKIPPED REMINDER
async function skippedReminder(req, res) {
  const result = await medicationReminderService.skippedReminder(req.params.id, req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_REMINDER_SKIPPED);
}


// SNOOZE REMINDER
async function snoozeReminder(req, res) {
  const result = await medicationReminderService.snoozeReminder(
    req.params.id,
    req.auth.userId,
    req.body.minutes || 10,
  );

  return successResponse(res, result, messageConstants.MEDICATION_REMINDER_SNOOZED);
}


// GET REFILL ALERTS
async function getRefillAlerts(req, res) {
  const result = await medicationReminderService.getRefillAlerts(req.auth.userId);

  return successResponse(res, result, messageConstants.REFILL_ALERTS_FETCHED);
}

// GET TODAY REFILL ALERTS
async function getTodayRefillAlerts(req, res) {
  const result = await medicationReminderService.getTodayRefillAlerts(req.auth.userId);

  return successResponse(res, result, messageConstants.TODAY_REFILL_ALERTS_FETCHED);
}


// COMPLETE REFILL ALERT
async function completeRefillAlert(req, res) {
  const result = await medicationReminderService.completeRefillAlert(
    req.params.id,
    req.auth.userId,
  );

  return successResponse(res, result, messageConstants.REFILL_ALERT_COMPLETED);
}


// SNOOZE REFILL ALERT
async function snoozeRefillAlert(req, res) {
  const result = await medicationReminderService.snoozeRefillAlert(
    req.params.id,
    req.auth.userId,
    req.body.minutes || 10,
  );

  return successResponse(res, result, messageConstants.REFILL_ALERT_SNOOZED);
}

module.exports = {
  createReminder,
  getAllReminders,
  getReminderById,
  deleteReminder,
  getTodayOccurrences,
  completeReminder,
  missedReminder,
  skippedReminder,
  snoozeReminder,
  getRefillAlerts,
  getTodayRefillAlerts,
  completeRefillAlert,
  snoozeRefillAlert,
};
