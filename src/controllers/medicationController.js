const { StatusCodes } = require("http-status-codes");
const { messageConstants } = require("../constants/messageConstants");
const { successResponse, paginatedSuccessResponse } = require("../helpers/generalResponse");
const medicationService = require("../services/medicationService");

//create medication

async function createMedication(req, res) {
  const result = await medicationService.createMedication(req.auth.userId, req.body);

  return successResponse(res, result, messageConstants.MEDICATION_CREATED, StatusCodes.CREATED);
}

//updated medication
async function updateMedication(req, res) {
  const result = await medicationService.updateMedication(req.params.id, req.auth.userId, req.body);

  return successResponse(res, result, messageConstants.MEDICATION_UPDATED);
}

//deleted medication
async function deleteMedication(req, res) {
  const result = await medicationService.deleteMedication(req.params.id, req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_DELETED);
}

//get medication by id
async function getMedicationById(req, res) {
  const result = await medicationService.getMedicationById(req.params.id, req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_FETCHED);
}

//get mediaction list
async function getMedicationList(req, res) {
  const userId = req.auth.userId;
  const result = await medicationService.getMedicationList(userId);
  return successResponse(res, result, messageConstants.MEDICATION_LIST_FETCHED);
}

//filtered list
async function listMedications(req, res) {
  const result = await medicationService.listMedications(req.body, req.auth.userId);

  return successResponse(res, result, messageConstants.MEDICATION_FILTERED_LIST_FETCHED);
}

//pagination list
async function listMedicationsPaginated(req, res) {
  const result = await medicationService.listMedicationsPaginated(req.body, req.auth.userId);

  return paginatedSuccessResponse(
    res,
    result.data,
    result.page,
    messageConstants.MEDICATION_FILTERED_LIST_FETCHED,
  );
}

module.exports = {
  createMedication,
  updateMedication,
  deleteMedication,
  getMedicationById,
  getMedicationList,
  listMedications,
  listMedicationsPaginated,
};
