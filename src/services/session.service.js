const sessionRepository = require("../repositories/sessionRepositoty");
const MessageConstant = require("../constant/MessageConstant");
const messageConstant = require("../constant/MessageConstant");
const jwt = require("jsonwebtoken");
const { InvalidRequestException } = require("../excptions/ApiError");

class SessionService {
  // create session
  async createSession(data) {
    if (!data.userId) {
      throw new InvalidRequestException("UserId is required");
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

  // logout session
  async logoutSession(token) {
    if (!token) {
      throw new InvalidRequestException(MessageConstant.INVALID_TOKEN); 
    }
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const sessionId=decoded.session;
    const existing = await sessionRepository.findById(sessionId);
    if (!existing) {
      throw new InvalidRequestException(MessageConstant.SESSION_NOT_FOUND);
    }
    const result = await sessionRepository.logout(sessionId);
    return { data: result, message: MessageConstant.LOGOUT_SUCCESS };
  }
}

module.exports = new SessionService();
