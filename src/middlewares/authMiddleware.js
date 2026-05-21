const { errorConstants } = require("../constants/errorConstants");
const { UnauthorizedException } = require("../exceptions/appError");
const sessionRepository = require("../repositories/sessionRepository");
const JwtUtils = require("../utils/jwtUtils");

async function verifyToken(req, _res, next) {
  try {
    const token = JwtUtils.getBearerToken(req.headers.authorization);
    const payload = JwtUtils.verifyAccessToken(token);

    if (!payload.sessionId || !payload.userId) {
      throw new UnauthorizedException(errorConstants.INVALID_TOKEN);
    }

    const activeSession = await sessionRepository.findActiveById(payload.sessionId);

    if (!activeSession || activeSession.userId !== payload.userId) {
      throw new UnauthorizedException(errorConstants.INVALID_SESSION_ID);
    }

    req.auth = {
      payload,
      session: activeSession,
      sessionId: activeSession.id,
      token,
      userId: activeSession.userId,
    };

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { verifyToken };
