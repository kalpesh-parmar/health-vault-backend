const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const uploadFileService = require("../services/uploadFileService");

async function uploadFile(req, res) {
  const result = await uploadFileService.uploadFile(req.file, req.body.uploadType);
  return successResponse(res, result, messageConstants.FILE_UPLOADED);
}
async function getSignedUrl(req, res) {
  const result = await uploadFileService.getSignedUrl(req.query.fileKey);
  return successResponse(res, result, messageConstants.FILE_FETCHED);
}
async function deleteFile(req, res) {
  const result = await uploadFileService.deleteFile(req.query);
  return successResponse(res, result, messageConstants.FILE_DELETED);
}

module.exports = {
  uploadFile,
  getSignedUrl,
  deleteFile,
};
