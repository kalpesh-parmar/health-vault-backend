const { StatusCodes } = require("http-status-codes");

const { errorConstants } = require("../constants/errorConstants");

class AppError extends Error {
  constructor(statusCode, message, errorCode) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.description = message;
    this.errorCode = errorCode;
    // this.details = details;
    Error.captureStackTrace(this, this.constructor);
  }
}

class InvalidRequestException extends AppError {
  constructor(message = errorConstants.INVALID_REQUEST) {
    super(StatusCodes.BAD_REQUEST, message, "INVALID_REQUEST");
  }
}

class UnauthorizedException extends AppError {
  constructor(message = errorConstants.UNAUTHORIZED) {
    super(StatusCodes.UNAUTHORIZED, message, "UNAUTHORIZED");
  }
}

class AccessDeniedException extends AppError {
  constructor(message = errorConstants.ACCESS_DENIED) {
    super(StatusCodes.FORBIDDEN, message, "ACCESS_DENIED");
  }
}

class NotFoundException extends AppError {
  constructor(message = errorConstants.NOT_FOUND) {
    super(StatusCodes.NOT_FOUND, message, "NOT_FOUND");
  }
}

class AlreadyExistsException extends AppError {
  constructor(message = errorConstants.ALREADY_EXISTS) {
    super(StatusCodes.CONFLICT, message, "ALREADY_EXISTS");
  }
}

class InternalServerException extends AppError {
  constructor(message = errorConstants.SOMETHING_WENT_WRONG) {
    super(StatusCodes.INTERNAL_SERVER_ERROR, message, "INTERNAL_SERVER_ERROR");
  }
}

module.exports = {
  AccessDeniedException,
  AlreadyExistsException,
  AppError,
  InternalServerException,
  InvalidRequestException,
  NotFoundException,
  UnauthorizedException,
};
