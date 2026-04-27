const messageConstant = require("../constant/MessageConstant");
const MessageConstant = require("../constant/MessageConstant");
const { StatusCodes } = require("http-status-codes");

//throw error
class AppError extends Error {
  constructor(code, description, errors = null) {
    super(description);
    this.code = code;
    this.description = description;
    this.status = "ERROR";
    this.errors = errors;
  }
}

class InvalidRequestException extends AppError {
  constructor(message = MessageConstant.INVALID_REQUEST, errors = null) {
    super(StatusCodes.BAD_REQUEST, message, errors);
  }
}

class NotFoundException extends AppError {
  constructor(message = MessageConstant.NOT_FOUND, errors = null) {
    super(StatusCodes.NOT_FOUND, message, errors);
  }
}

class AlredayExistsException extends AppError {
  constructor(message = messageConstant.ALREADY_EXIST, errors = null) {
    super(StatusCodes.CONFLICT, message, errors);
  }
}

class UnauthorizedException extends AppError {
  constructor(message = MessageConstant.UNAUTHORIZED, errors = null) {
    super(StatusCodes.UNAUTHORIZED, message, errors);
  }
}

class AccessDeniedError extends AppError {
  constructor(message = MessageConstant.ACCESS_DENIED, errors = null) {
    super(StatusCodes.FORBIDDEN, message, errors);
  }
}

class InternalServerError extends AppError {
  constructor(message = MessageConstant.INTERNAL_SERVER_ERROR, errors = null) {
    super(
      StatusCodes.INTERNAL_SERVER_ERROR,
      messageConstant.SOMETHING_WENT_WRONG,
      errors
    );
  }
}
module.exports = {
  AppError,
  InvalidRequestException,
  NotFoundException,
  AlredayExistsException,
  UnauthorizedException,
  AccessDeniedError,
  InternalServerError,
};
