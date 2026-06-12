const { StatusCodes } = require("http-status-codes");

const { AppError } = require("../../../exceptions/appError");

/**
 * Raised when OCR completes the request lifecycle but produces no usable
 * text from any engine. Surfaced as HTTP 422 so callers receive an explicit
 * failure instead of a misleading success with empty content.
 */
class OcrEmptyResultError extends AppError {
  constructor(message = "OCR produced no usable text", details = {}) {
    super(StatusCodes.UNPROCESSABLE_ENTITY, message, "OCR_EMPTY_RESULT");
    this.details = details;
  }
}

/** Unsupported MIME type / file extension. */
class UnsupportedDocumentError extends AppError {
  constructor(message = "Unsupported document type", details = {}) {
    super(StatusCodes.UNSUPPORTED_MEDIA_TYPE, message, "UNSUPPORTED_DOCUMENT");
    this.details = details;
  }
}

/** File exceeds the configured size cap. */
class FileTooLargeError extends AppError {
  constructor(message = "File too large for inline processing", details = {}) {
    super(StatusCodes.REQUEST_TOO_LONG, message, "FILE_TOO_LARGE");
    this.details = details;
  }
}

/** File bytes are empty or cannot be decoded. */
class CorruptedFileError extends AppError {
  constructor(message = "File is empty or corrupted", details = {}) {
    super(StatusCodes.BAD_REQUEST, message, "CORRUPTED_FILE");
    this.details = details;
  }
}

/**
 * The configured AI model returned a response that could not be parsed or did not match
 * the expected schema. Carries diagnostic fields so callers can surface
 * actionable error messages instead of a generic failure.
 */
class GeminiInvalidResponseError extends AppError {
  constructor({ message, details = {}, rawSnippet, parseError, validationErrors } = {}) {
    super(
      StatusCodes.UNPROCESSABLE_ENTITY,
      message || "Configured AI model returned an unparseable or schema-invalid response",
      "GEMINI_INVALID_RESPONSE",
    );
    this.details = {
      ...details,
      rawSnippet,
      parseError,
      validationErrors,
    };
  }
}

module.exports = {
  OcrEmptyResultError,
  UnsupportedDocumentError,
  FileTooLargeError,
  CorruptedFileError,
  GeminiInvalidResponseError,
};
