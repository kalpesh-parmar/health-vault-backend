const STATUS_CODE = require("../constant/statusCode");

class GeneralResponse {
  static success(res, data = null, message = "Success") {
    return res.status(STATUS_CODE.OK).json({
      success: true,
      statusCode: STATUS_CODE.OK,
      message,
      data,
    });
  }

  static created(res, data = null, message = "Created successfully") {
    return res.status(STATUS_CODE.CREATED).json({
      success: true,
      statusCode: STATUS_CODE.CREATED,
      message,
      data,
    });
  }

  static badRequest(res, message = "Bad request", errors = null) {
    return res.status(STATUS_CODE.BAD_REQUEST).json({
      success: false,
      statusCode: STATUS_CODE.BAD_REQUEST,
      message,
      errors,
    });
  }

  static notFound(res, message = "Not found") {
    return res.status(STATUS_CODE.NOT_FOUND).json({
      success: false,
      statusCode: STATUS_CODE.NOT_FOUND,
      message,
    });
  }

  static serverError(res, message = "Internal server error") {
    return res.status(STATUS_CODE.INTERNAL_SERVER_ERROR).json({
      success: false,
      statusCode: STATUS_CODE.INTERNAL_SERVER_ERROR,
      message,
    });
  }
}

module.exports = GeneralResponse;
