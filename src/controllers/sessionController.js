const sessionService = require("../services/session.service");
const GeneralResponse = require("../helpers/genralResponse");
const MessageConstant = require("../constant/MessageConstant");
const {
  createSessionSchema,
  logoutSchema,
  deleteSchema,
} = require("../validation/sessionValidation");
const jwt = require("jsonwebtoken");

class SessionController {
  //create session
  async createSession(req, res) {
    try {
      const { token } = createSessionSchema.parse(req.body);
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const data = {
        userId: decoded.userId,
      };
      const result = await sessionService.createSession(data);

      return GeneralResponse.created(
        res,
        result,
        MessageConstant.SESSION_CREATED,
      );
    } catch (error) {
      if (error.name === "ZodError") {
        return GeneralResponse.badRequest(
          res,
          MessageConstant.VALIDATION_FAILED,
          error.errors,
        );
      }
      if (error.name === "JsonWebTokenError") {
      return GeneralResponse.UnauthorizeResponse(
        res,
        "Invalid token"
      );
    }
      return GeneralResponse.serverError(res, error.message);
    }
  }
  // get session by id
  async getSessionById(req, res) {
    try {
      const sessionId = Number(req.params.id);

      if (!sessionId) {
        return GeneralResponse.badRequest(res, "Invalid session id");
      }

      const result = await sessionService.getSessionById(sessionId);

      return GeneralResponse.success(
        res,
        result,
        MessageConstant.SESSION_FETCHED,
      );
    } catch (error) {
      if (error.message === MessageConstant.SESSION_NOT_FOUND) {
        return GeneralResponse.notFound(res, error.message);
      }

      return GeneralResponse.serverError(res, error.message);
    }
  }
  // logout session
  async logout(req, res) {
    try {
      const validated = logoutSchema.parse(req.body);

      const result = await sessionService.logoutSession(validated.sessionId);

      return GeneralResponse.success(
        res,
        result,
        MessageConstant.LOGOUT_SUCCESS,
      );
    } catch (error) {
      if (error.message === MessageConstant.SESSION_NOT_FOUND) {
        return GeneralResponse.notFound(res, error.message);
      }

      if (error.name === "ZodError") {
        return GeneralResponse.badRequest(
          res,
          MessageConstant.VALIDATION_FAILED,
          error.errors,
        );
      }

      return GeneralResponse.serverError(res, error.message);
    }
  }
}

module.exports = new SessionController();
