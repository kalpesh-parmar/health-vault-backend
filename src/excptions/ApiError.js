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
    super(StatusCodes.NOT_FOUND, message);
  }
}

class AlredayExistsException extends AppError {
  constructor(message = messageConstant.ALREADY_EXIST) {
    super(StatusCodes.CONFLICT, message);
  }
}

class UnauthorizedException extends AppError {
  constructor(message = MessageConstant.UNAUTHORIZED) {
    super(StatusCodes.UNAUTHORIZED, message);
  }
}

class AccessDeniedError extends AppError {
  constructor(message = MessageConstant.ACCESS_DENIED) {
    super(StatusCodes.FORBIDDEN, message);
  }
}

class InternalServerError extends AppError {
  constructor(message = MessageConstant.INTERNAL_SERVER_ERROR) {
    super(
      StatusCodes.INTERNAL_SERVER_ERROR,
      messageConstant.SOMETHING_WENT_WRONG,
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
