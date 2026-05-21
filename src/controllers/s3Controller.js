const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const s3Service = require("../services/s3service");

async function uploadFile(req, res) {
  const result = await s3Service.uploadFile(req.file, req.body);
  return successResponse(res, result, messageConstants.FILE_UPLOADED);
}

async function fileDelete(req, res) {
  const result = await s3Service.deleteFile(req.file, req.body);
  return successResponse(res, result, messageConstants.FILE_DELETED);
}

async function getSignedUrl(req, res) {
  const result = await s3Service.getSignedFileUrl();
  return successResponse(res, result, messageConstants.FILE_FETCHED);
}

module.exports = {
  uploadFile,
  fileDelete,
  getSignedUrl,
};
