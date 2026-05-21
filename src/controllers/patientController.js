const { StatusCodes } = require("http-status-codes");

const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const patientService = require("../services/patientService");

async function loginPatient(req, res) {
  const result = await patientService.loginPatient(req.body);
  return successResponse(res, result, messageConstants.PATIENT_LOGIN_SUCCESS);
}

async function refreshToken(req, res) {
  const result = await patientService.refreshToken(req.body);
  return successResponse(res, result, messageConstants.TOKEN_REFRESHED);
}

async function createPatient(req, res) {
  const result = await patientService.createPatient(req.body);
  return successResponse(res, result, messageConstants.PATIENT_CREATED, StatusCodes.CREATED);
}
async function profilePicDelete(req, res) {
  const result = await patientService.profilePicDelete(req.body);
  return successResponse(res, result, messageConstants.PROFILE_PICTURE_DELETED);
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

async function requestOtp(req, res) {
  const result = await patientService.requestOtp(req.body);
  return successResponse(res, result, messageConstants.OTP_SENT);
}

async function forgotPassword(req, res) {
  const result = await patientService.forgotPassword(req.body);
  return successResponse(res, result, messageConstants.OTP_SENT);
}

async function verifyOtp(req, res) {
  const result = await patientService.verifyOtp(req.body);
  return successResponse(res, result, messageConstants.OTP_VERIFIED);
}

async function resetPassword(req, res) {
  const result = await patientService.resetPassword(req.body);
  return successResponse(res, result, messageConstants.PASSWORD_RESET_SUCCESS);
}

async function getPatientProfile(req, res) {
  const result = await patientService.getPatientProfile(req.auth.userId);
  return successResponse(res, result, messageConstants.PATIENT_PROFILE_FETCHED);
}

module.exports = {
  createPatient,
  profilePicDelete,
  deletePatient,
  forgotPassword,
  getPatientProfile,
  getPatientById,
  getPatientList,
  loginPatient,
  logoutPatient,
  permanentDeletePatient,
  refreshToken,
  requestOtp,
  resetPassword,
  updatePatient,
  verifyOtp,
};
