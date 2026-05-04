const { randomUUID } = require("crypto");

const { env } = require("../configs/env");
const { errorConstants } = require("../constants/errorConstants");
const { responseConstants } = require("../constants/responseConstants");
const { NotFoundException } = require("../exceptions/appError");
const patientRepository = require("../repositories/patientRepository");
const sessionRepository = require("../repositories/sessionRepository");
const { hashToken, parseDurationToDate } = require("../utils/commonUtils");
const JwtUtils = require("../utils/jwtUtils");
const { createSessionSchema, idParamSchema, validateSchema } = require("../validations");

class SessionService {
  async createSession(userId, payload) {
    const data = await validateSchema(createSessionSchema, payload);
    const existingPatient = await patientRepository.findById(userId);

    if (!existingPatient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const sessionId = randomUUID();
    const accessToken = JwtUtils.generateAccessToken(
      {
        sessionId,
        userId,
      },
      {
        subject: userId,
      },
    );
    const refreshToken = JwtUtils.generateRefreshToken(
      {
        sessionId,
        userId,
      },
      {
        subject: userId,
      },
    );
    const session = await sessionRepository.create({
      deviceToken: data.deviceToken,
      id: sessionId,
      refreshTokenExpiresAt: parseDurationToDate(env.jwtRefreshExpiresIn),
      refreshTokenHash: hashToken(refreshToken),
      userId,
    });

    return {
      accessToken,
      refreshToken,
      session,
      tokenType: responseConstants.TOKEN_TYPE,
    };
  }

  async getSessionById(sessionId) {
    const params = await validateSchema(idParamSchema, { id: sessionId });
    const session = await sessionRepository.findById(params.id);

    if (!session) {
      throw new NotFoundException(errorConstants.SESSION_NOT_FOUND);
    }

    return session;
  }
}

module.exports = new SessionService();
