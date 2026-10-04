const { StatusCodes } = require("http-status-codes");
const { messageConstants } = require("../constants/messageConstants");
const { successResponse, paginatedSuccessResponse } = require("../helpers/generalResponse");
const medicationService = require("../services/medication.service");

//create medication (supports single or batch array)
async function createMedication(req, res) {
  const result = await medicationService.createMedication(req.auth.userId, req.body);
  const isBatch = Array.isArray(result) || (result && result.created !== undefined);
  const msg = isBatch
    ? messageConstants.MEDICATIONS_BATCH_CREATED
    : messageConstants.MEDICATION_CREATED;

  return successResponse(res, result, msg, StatusCodes.CREATED);
}

// batch create medications
async function batchCreateMedications(req, res) {
  const result = await medicationService.createMedication(req.auth.userId, req.body);

  return successResponse(
    res,
    result,
    messageConstants.MEDICATIONS_BATCH_CREATED,
    StatusCodes.CREATED,
  );
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
  const result = await medicationService.getMedicationList(userId, req.query);
  return paginatedSuccessResponse(
    res,
    result.data,
    result.page,
    messageConstants.MEDICATION_LIST_FETCHED,
  );
}

//filtered list
async function listMedications(req, res) {
  const userId = req.auth.userId;
  const result = await medicationService.listMedications(req.body, userId);

  return successResponse(res, result, messageConstants.MEDICATION_FILTERED_LIST_FETCHED);
}

//pagination list
async function listMedicationsPaginated(req, res) {
  const userId = req.auth.userId;
  const result = await medicationService.listMedicationsPaginated(req.body, userId);

  return paginatedSuccessResponse(
    res,
    result.data,
    result.page,
    messageConstants.MEDICATION_FILTERED_LIST_FETCHED,
  );
}

// refill medication
async function refillMedication(req, res) {
  const result = await medicationService.refillMedication(req.params.id, req.auth.userId, req.body);

  return successResponse(res, result, messageConstants.MEDICATION_REFILLED);
}

// check duplicate medication
async function checkDuplicateMedication(req, res) {
  const result = await medicationService.checkDuplicateMedication(req.auth.userId, req.body);
  return successResponse(res, result, messageConstants.MEDICATION_DUPLICATE_CHECKED);
}

// batch delete medications
async function batchDeleteMedications(req, res) {
  const result = await medicationService.batchDeleteMedications(req.auth.userId, req.body);

  return successResponse(res, result, messageConstants.MEDICATIONS_BATCH_DELETED);
}

module.exports = {
  createMedication,
  batchCreateMedications,
  updateMedication,
  deleteMedication,
  batchDeleteMedications,
  getMedicationById,
  getMedicationList,
  listMedications,
  listMedicationsPaginated,
  refillMedication,
  checkDuplicateMedication,
};
