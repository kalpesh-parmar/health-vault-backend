const sessionRepository = require("../repositories/sessionRepository");
const MessageConstant = require("../constant/MessageConstant");
const messageConstant = require("../constant/MessageConstant");
const jwt = require("jsonwebtoken");
const { InvalidRequestException } = require("../excptions/ApiError");
const { checkValidateToken } = require("../utils/jwtUtils");

class SessionService {
  // create session
  async createSession(data) {
    if (!data.userId || data.userId === null || data.userId === undefined) {
      throw new InvalidRequestException(messageConstant.USERID_REQUIRED);
    }
    return await sessionRepository.create(data);
  }

  // get session by id
  async getSessionById(sessionId) {
    if (!sessionId) {
      throw new InvalidRequestException(MessageConstant.INVALID_SESSIONID);
    }
    const session = await sessionRepository.findById(sessionId);

    if (!session) {
      throw new InvalidRequestException(MessageConstant.SESSION_NOT_FOUND);
    }

    return session;
  }
}

module.exports = new SessionService();
