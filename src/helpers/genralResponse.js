const STATUS_CODE = require("../constant/statusCode");

class GeneralResponse {
  constructor(res, data, statusCode, success, message, errors = null) {
    this.data = data;
    this.success = success;
    this.statusCode = statusCode;
    this.message = message;
    this.errors = errors;

    if (res) {
      res.status(statusCode).json({
        status: {
          success: success,
          statusCode: statusCode,
          message: message,
        },
        data: data,
      });
    }
  }

  // 200 OK
  static success(res, data = null, message = "Success") {
    return new GeneralResponse(res, data, STATUS_CODE.OK, true, message);
  }

  // 201 Created
  static created(res, data = null, message = "Created successfully") {
    return new GeneralResponse(res, data, STATUS_CODE.CREATED, true, message);
  }

  // 400 Bad Request
  static badRequest(res, message = "Bad request", errors = null) {
    return new GeneralResponse(
      res,
      null,
      STATUS_CODE.BAD_REQUEST,
      false,
      message,
      errors,
    );
  }

  // 404 Not Found
  static notFound(res, message = "Not found") {
    return new GeneralResponse(
      res,
      null,
      STATUS_CODE.NOT_FOUND,
      false,
      message,
    );
  }

  // 500 Internal Server Error
  static serverError(res, message = "Internal server error") {
    return new GeneralResponse(
      res,
      null,
      STATUS_CODE.INTERNAL_SERVER_ERROR,
      false,
      message,
    );
  }

  //401 Unauthorized Error
  static UnauthorizeResponse(res, message = "Unauthorized error") {
  return new UnauthorizedResponse(
    401,
    null,
    STATUS_CODE.UNAUTHORIZED,
    false,
    message,
  );
}
}

module.exports = GeneralResponse;
