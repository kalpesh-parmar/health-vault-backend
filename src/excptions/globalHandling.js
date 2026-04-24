const GeneralResponse = require("../helpers/genralResponse");
const { ZodError } = require("zod");
const messageConstant = require("../constant/messageConstant");

function errorMiddleware(err, req, res, next) {
  if (err.errors && Array.isArray(err.errors)) {
    const formattedErrors = err.errors.map(e => ({
      field: e.path?.join?.(".") || "",
      message: e.message,
    }));

    return GeneralResponse.badRequest(
      res,
      "Validation failed",
      formattedErrors
    );
  }
  return GeneralResponse.serverError(
    res,
    err.message || messageConstant.INTERNAL_SERVER_ERROR
  );
}

module.exports = errorMiddleware;