const { StatusCodes } = require("http-status-codes");
const { successResponse } = require("../helpers/generalResponse");
const { messageConstants } = require("../constants/messageConstants");
const medicationReminderService = require("../services/medicationReminderService");

//create
async function createReminder(req, res) {
  const result = await medicationReminderService.createReminder(req.auth.userId, req.body);
  return successResponse(
    res,
    result,
    messageConstants.MEDICATION_REMINDER_CREATED,
    StatusCodes.CREATED,
  );
}
//get all main reminder
async function getAllReminders(req, res) {
  const result = await medicationReminderService.getAllReminders(req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_REMINDER_LIST_FETCHED);
}
//delete reminder
async function deleteReminder(req, res) {
  const result = await medicationReminderService.deleteReminder(req.params.id, req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_REMINDER_DELETED);
}
//get all sub remider
async function getAllOccurrences(req, res) {
  const result = await medicationReminderService.getAllOccurrences(req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_OCCURRENCES_FETCHED);
}
//filter occurrences
async function getOccurrences(req, res) {
  const result = await medicationReminderService.getOccurrences(req.auth.userId, req.body);

  return successResponse(res, result, messageConstants.MEDICATION_OCCURRENCES_FETCHED);
}
//updated
async function updateOccurrence(req, res) {
  const result = await medicationReminderService.updateOccurrence(
    req.params.id,
    req.auth.userId,
    req.body,
  );

  return successResponse(res, result, messageConstants.MEDICATION_OCCURRENCE_UPDATED);
}
//get today occurrences
async function getTodayOccurrences(req, res) {
  const result = await medicationReminderService.getTodayOccurrences(req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_OCCURRENCES_FETCHED);
}

module.exports = {
  createReminder,
  getAllReminders,
  deleteReminder,
  getAllOccurrences,
  getOccurrences,
  updateOccurrence,
  getTodayOccurrences,
};
