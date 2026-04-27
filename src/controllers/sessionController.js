const sessionService = require("../services/session.service");
const GeneralResponse = require("../helpers/genralResponse");
const MessageConstant = require("../constant/MessageConstant");
const jwt = require("jsonwebtoken");

class SessionController {
  //create session
  async createSession(req, res, next) {
    try {
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
      console.log("error in create session:", error);
      next(error);
    }
  }
  // get session by id
  async getSessionById(req, res, next) {
    try {
      const sessionId = Number(req?.params?.id);
      const result = await sessionService.getSessionById(sessionId);

      return GeneralResponse.success(
        res,
        result,
        MessageConstant.SESSION_FETCHED,
      );
    } catch (error) {
      console.log("error in getSessionById:", error);
      next(error);
    }
  }
}

module.exports = new SessionController();
