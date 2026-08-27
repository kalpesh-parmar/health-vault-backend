const { StatusCodes } = require("http-status-codes");

const { errorConstants } = require("../constants/errorConstants");

const FATAL_ERROR_CODES = Object.freeze(
  new Set([
    "INVALID_DOCUMENT_TYPE",
    "UPLOADED_FILE_NOT_A_VALID_MEDICAL_DOCUMENT",
    "NON_MEDICAL_DOCUMENT",
    "FILE_SIZE_INVALID",
    "FILE_TOO_LARGE",
    "CORRUPT_FILE",
    "ENCRYPTED_FILE",
    "UNSUPPORTED_MEDIA_TYPE",
  ]),
);

class AppError extends Error {
  constructor(statusCode, message, errorCode, retryable = undefined) {
    super(message);
    this.name = this.constructor.name;
    this.statusCode = statusCode;
    this.description = message;
    this.errorCode = errorCode;
    this._retryable = retryable;
    Error.captureStackTrace(this, this.constructor);
  }

  get retryable() {
    if (this._retryable !== undefined) {
      return this._retryable;
    }
    if (this.errorCode && FATAL_ERROR_CODES.has(this.errorCode)) {
      return false;
    }
    return true;
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

class NonMedicalDocumentException extends AppError {
  constructor(message = "The uploaded file is not a medical document.", classification = null) {
    super(StatusCodes.BAD_REQUEST, message, "NON_MEDICAL_DOCUMENT");
    this.reason = message;
    this.classification = classification;
  }
}

class SessionExpiredException extends AppError {
  constructor(message = "Session expired. Please login again.") {
    super(StatusCodes.UNAUTHORIZED, message, "SESSION_EXPIRED");
    this.forceLogout = true;
  }
}

class ConflictException extends AppError {
  constructor(message = "Resource conflict", details = null, errorCode = "CONFLICT") {
    super(StatusCodes.CONFLICT, message, errorCode, details);
    this.details = details;
  }
}

class ClassifierUnavailableException extends AppError {
  constructor(message = "Document classification service is temporarily unavailable.") {
    super(StatusCodes.SERVICE_UNAVAILABLE, message, "CLASSIFIER_UNAVAILABLE");
  }
}

function isErrorRetryable(error) {
  if (!error) return true;
  if (typeof error.retryable === "boolean") return error.retryable;
  if (error._retryable !== undefined) return Boolean(error._retryable);
  const code = error.errorCode || error.code;
  if (code && FATAL_ERROR_CODES.has(code)) return false;
  return true;
}

module.exports = {
  AccessDeniedException,
  AlreadyExistsException,
  AppError,
  ClassifierUnavailableException,
  ConflictException,
  FATAL_ERROR_CODES,
  InternalServerException,
  InvalidRequestException,
  NotFoundException,
  UnauthorizedException,
  NonMedicalDocumentException,
  SessionExpiredException,
  isErrorRetryable,
};
