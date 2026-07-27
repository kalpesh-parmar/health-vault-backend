const { StatusCodes } = require("http-status-codes");
const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const patientService = require("../services/patient.service");
const documentService = require("../services/document.service");

// async function firebaseLogin(req, res) {
//   const result = await patientService.firebaseLogin(req.body);
//   return successResponse(res, result, messageConstants.PATIENT_LOGIN_SUCCESS);
// }

async function refreshToken(req, res) {
  const result = await patientService.refreshToken(req.body);
  return successResponse(res, result, messageConstants.TOKEN_REFRESHED);
}

async function getPatientById(req, res) {
  const result = await patientService.getPatientById(req.params.id);
  return successResponse(res, result, messageConstants.PATIENT_FETCHED);
}

async function getPatientList(req, res) {
  const result = await patientService.getPatientList(req.query);
  return successResponse(res, result, messageConstants.PATIENT_LIST_FETCHED);
}

async function updatePatient(req, res) {
  const result = await patientService.updatePatient(req.params.id, req.body);
  return successResponse(res, result, messageConstants.PATIENT_UPDATED);
}

async function deletePatient(req, res) {
  const result = await patientService.deletePatient(req.params.id);
  return successResponse(res, result, messageConstants.PATIENT_DELETED);
}

async function permanentDeletePatient(req, res) {
  const result = await patientService.permanentDeletePatient(req.params.id);
  return successResponse(res, result, messageConstants.PATIENT_PERMANENTLY_DELETED);
}

async function logoutPatient(req, res) {
  const result = await patientService.logoutPatient(req.auth.sessionId);
  return successResponse(res, result, messageConstants.PATIENT_LOGGED_OUT);
}

async function getPatientProfile(req, res) {
  const result = await patientService.getPatientProfile(req.auth.userId);
  return successResponse(res, result, messageConstants.PATIENT_PROFILE_FETCHED);
}

async function socialLogin(req, res) {
  const result = await patientService.socialLogin(req.body);
  return successResponse(res, result, messageConstants.PATIENT_LOGIN_SUCCESS);
}

async function reportAuthFailure(req, res) {
  const result = await patientService.reportAuthFailure(req.body);
  return successResponse(res, result, messageConstants.FAILED_ATTEMPT_LOGGED);
}

async function uploadProfileImage(req, res) {
  const result = await patientService.uploadProfileImage(
    req.params.patientId,
    req.file,
    req.auth.userId,
  );
  return successResponse(res, result, messageConstants.FILE_UPLOADED, StatusCodes.OK);
}

async function uploadDocuments(req, res) {
  const result = await documentService.uploadPatientDocuments(
    req.params.patientId,
    req.files,
    req.auth.userId,
  );
  return successResponse(res, result, messageConstants.FILE_UPLOADED, StatusCodes.ACCEPTED);
}

module.exports = {
  deletePatient,
  getPatientProfile,
  getPatientById,
  getPatientList,
  logoutPatient,
  permanentDeletePatient,
  refreshToken,
  updatePatient,
  socialLogin,
  reportAuthFailure,
  uploadProfileImage,
  uploadDocuments,
};
