const sessionRepository = require("../repositories/sessionRepositoty");
const MessageConstant = require("../constant/MessageConstant");

class SessionService {
  // create session
  async createSession(data) {
    if (!data.userId) {
    throw new Error("UserId is required");
  }
    return await sessionRepository.create(data);
  }

  // get session by id
  async getSessionById(sessionId) {
    const session = await sessionRepository.findById(sessionId);

    if (!session) {
      throw new Error(MessageConstant.SESSION_NOT_FOUND);
    }

    return session;
  }

  // logout session
  async logoutSession(sessionId) {
    const existing = await sessionRepository.findById(sessionId);

    if (!existing) {
      throw new Error(MessageConstant.SESSION_NOT_FOUND);
    }

    if (!existing.isActive) {
      throw new Error(MessageConstant.ALREADY_LOGOUT);
    }

    const result = await sessionRepository.logout(sessionId);
    return { data: result, message: MessageConstant.LOGOUT_SUCCESS };
  }
}

module.exports = new SessionService();  
