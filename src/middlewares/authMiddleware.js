const { SessionExpiredException } = require("../exceptions/appError");
const sessionRepository = require("../repositories/sessionRepository");
const patientRepository = require("../repositories/patientRepository");
const JwtUtils = require("../utils/jwtUtils");

async function verifyToken(req, _res, next) {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      throw new SessionExpiredException("User not found or session expired");
    }

    let token;
    let payload;
    try {
      token = JwtUtils.getBearerToken(authHeader);
      payload = JwtUtils.verifyAccessToken(token);
    } catch {
      throw new SessionExpiredException("User not found or session expired");
    }

    if (!payload.sessionId || !payload.userId || payload.tokenType !== "access") {
      throw new SessionExpiredException("User not found or session expired");
    }

    // Verify user exists and is ACTIVE
    const user = await patientRepository.findById(payload.userId);
    if (!user || user.status !== "ACTIVE") {
      throw new SessionExpiredException("User not found or session expired");
    }

    // Verify session exists and is ACTIVE
    const activeSession = await sessionRepository.findActiveById(payload.sessionId);
    if (!activeSession || activeSession.userId !== payload.userId) {
      throw new SessionExpiredException("User not found or session expired");
    }

    req.auth = {
      payload,
      session: activeSession,
      sessionId: activeSession.id,
      token,
      userId: activeSession.userId,
      user,
    };

    return next();
  } catch (error) {
    return next(error);
  }
}

module.exports = { verifyToken };
