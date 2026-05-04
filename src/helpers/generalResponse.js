const { StatusCodes } = require("http-status-codes");

const { responseConstants } = require("../constants/responseConstants");

function normalizeData(data) {
  if (data === undefined || data === null) {
    return {};
  }

  return data;
}

function successResponse(
  res,
  data = {},
  message = responseConstants.DEFAULT_SUCCESS_MESSAGE,
  statusCode = StatusCodes.OK,
  meta = {},
) {
  return res.status(statusCode).json({
    data: normalizeData(data),
    ...meta,
    status: {
      description: message,
      status: responseConstants.SUCCESS,
      statusCode,
    },
  });
}

function paginatedSuccessResponse(
  res,
  data = [],
  page = {},
  message = responseConstants.DEFAULT_SUCCESS_MESSAGE,
  statusCode = StatusCodes.OK,
) {
  return successResponse(res, data, message, statusCode, { page });
}

function errorResponse(res, error) {
  const statusCode = error.statusCode || StatusCodes.INTERNAL_SERVER_ERROR;

  return res.status(statusCode).json({
    details: error.details || null,
    errorCode: error.errorCode || "INTERNAL_SERVER_ERROR",
    message: error.description || error.message || responseConstants.DEFAULT_ERROR_MESSAGE,
    success: false,
  });
}

module.exports = {
  errorResponse,
  paginatedSuccessResponse,
  successResponse,
};
