const { StatusCodes } = require("http-status-codes");

const { errorConstants } = require("../constants/errorConstants");
const { AppError, InternalServerException } = require("../exceptions/appError");
const { errorResponse } = require("../helpers/generalResponse");

function errorHandler(error, _req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  if (error instanceof AppError) {
    return errorResponse(res, error);
  }
  console.log(error);
  const serverError =
    error?.statusCode && error.statusCode < StatusCodes.INTERNAL_SERVER_ERROR
      ? error
      : new InternalServerException(errorConstants.SOMETHING_WENT_WRONG);

  return errorResponse(res, serverError);
}

module.exports = errorHandler;
