const { randomUUID } = require("crypto");
const bcrypt = require("bcrypt");
const { env } = require("../configs/env");
const { errorConstants } = require("../constants/errorConstants");
const { responseConstants } = require("../constants/responseConstants");
const { USER_STATUS } = require("../enums/userStatus.enum");
const {
  AlreadyExistsException,
  InvalidRequestException,
  NotFoundException,
  UnauthorizedException,
} = require("../exceptions/appError");
const documentRepository = require("../repositories/documentRepository");
const patientRepository = require("../repositories/patientRepository");
const sessionRepository = require("../repositories/sessionRepository");
const {
  generateNumericPatientCode,
  hashToken,
  parseDurationToDate,
  sanitizePatient,
} = require("../utils/commonUtils");
const JwtUtils = require("../utils/jwtUtils");
const {
  firebaseLoginSchema,
  idParamSchema,
  listPatientsQuerySchema,
  refreshTokenSchema,
  updatePatientSchema,
  validateSchema,
} = require("../validations");
const { verifyFirebaseToken } = require("../configs/firebase");
const emailService = require("./emailService");
const objectStorageService = require("./objectStorageService");

async function createUniquePatientCode() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const patientCode = generateNumericPatientCode();
    const existingPatient = await patientRepository.findByPatientCode(patientCode);

    if (!existingPatient) {
      return patientCode;
    }
  }

  throw new AlreadyExistsException(errorConstants.ALREADY_EXISTS);
}

function assertPatientCanAuthenticate(existingPatient) {
  if (existingPatient.status === USER_STATUS.BLOCKED) {
    throw new UnauthorizedException(errorConstants.ACCOUNT_BLOCKED);
  }

  if (existingPatient.status === USER_STATUS.INACTIVE) {
    throw new UnauthorizedException(errorConstants.ACCOUNT_INACTIVE);
  }
}

function createTokenPair(existingPatient, sessionId) {
  const tokenPayload = {
    sessionId,
    userId: existingPatient.id,
  };

  return {
    accessToken: JwtUtils.generateAccessToken(
      {
        ...tokenPayload,
        tokenType: "access",
      },
      {
        subject: existingPatient.id,
      },
    ),
    refreshToken: JwtUtils.generateRefreshToken(tokenPayload, {
      subject: existingPatient.id,
    }),
  };
}

async function persistSession(existingPatient, deviceToken = null) {
  const sessionId = randomUUID();
  const tokens = createTokenPair(existingPatient, sessionId);

  await sessionRepository.create({
    deviceToken,
    id: sessionId,
    refreshTokenExpiresAt: parseDurationToDate(env.jwtRefreshExpiresIn),
    refreshTokenHash: hashToken(tokens.refreshToken),
    userId: existingPatient.id,
  });

  return {
    ...tokens,
    sessionId,
    expiresIn: env.jwtAccessExpiresIn,
    refreshExpiresIn: env.jwtRefreshExpiresIn,
    tokenType: responseConstants.TOKEN_TYPE,
  };
}

class PatientService {
  async handleFailedSecurityAttempt(existingPatient) {
    const nextAttempts = existingPatient.loginAttempts + 1;
    const shouldBlock = nextAttempts >= env.maxLoginAttempts;
    const updatedPatient = await patientRepository.updateById(existingPatient.id, {
      blockedAt: shouldBlock ? new Date() : existingPatient.blockedAt,
      loginAttempts: nextAttempts,
      status: shouldBlock ? USER_STATUS.BLOCKED : existingPatient.status,
    });

    if (shouldBlock) {
      await emailService.sendAccountBlockedEmail(updatedPatient);
    }

    return updatedPatient;
  }

  async firebaseLogin(payload) {
    const data = await validateSchema(firebaseLoginSchema, payload);
    const tokenToVerify = data.firebaseIdToken || data.firebaseToken;

    let decodedToken;
    if (env.enableDummyAuth && tokenToVerify === "dummy-token-msAipc6g4vNEQl24OePv56pe6Qy2") {
      console.log("[DUMMY_AUTH] Bypassing Firebase authentication. Using mock user credentials.");
      decodedToken = {
        uid: "msAipc6g4vNEQl24OePv56pe6Qy2",
        phone_number: "+911111111111",
      };
    } else {
      console.log("[FIREBASE_AUTH] Verifying ID token with Firebase Admin SDK.");
      try {
        decodedToken = await verifyFirebaseToken(tokenToVerify);
      } catch (error) {
        console.error("Firebase ID Token verification failed:", error);
        throw new UnauthorizedException("Invalid Firebase token");
      }
    }

    const mobileFull = decodedToken.phone_number;
    if (!mobileFull) {
      throw new InvalidRequestException("Firebase token does not contain a phone number");
    }

    // Helper to extract countryCode and mobile
    const cleaned = mobileFull.replace(/[^+\d]/g, "");
    let mobile = cleaned;
    let countryCode = null;
    if (cleaned.startsWith("+") && cleaned.length > 10) {
      mobile = cleaned.slice(-10);
      countryCode = cleaned.slice(0, cleaned.length - 10);
    }

    const firebaseUid = decodedToken.uid;
    let existingPatient = await patientRepository.findByFirebaseUid(firebaseUid);
    if (!existingPatient) {
      existingPatient = await patientRepository.findByMobile(mobile);
    }

    let isNewUser = false;
    if (!existingPatient) {
      isNewUser = true;
      const patientCode = await createUniquePatientCode();
      existingPatient = await patientRepository.create({
        patientCode,
        mobile,
        countryCode,
        firebaseUid,
        isActive: true,
        status: USER_STATUS.ACTIVE,
        firstName: null,
        lastName: null,
        fullName: null,
        gender: null,
        dateOfBirth: null,
        bloodGroup: null,
        allergies: null,
        isVerified: true,
        lastLoginAt: new Date(),
      });
    } else {
      assertPatientCanAuthenticate(existingPatient);
      isNewUser = false;
      existingPatient = await patientRepository.updateById(existingPatient.id, {
        lastLoginAt: new Date(),
        firebaseUid,
      });
    }

    const isOnboardingCompleted = !!(
      existingPatient.firstName &&
      existingPatient.firstName !== "User" &&
      existingPatient.lastName &&
      !existingPatient.lastName.startsWith("+") &&
      existingPatient.gender &&
      existingPatient.dateOfBirth
    );

    const tokens = await persistSession(existingPatient, data.deviceToken);

    return {
      success: true,
      token: tokens.accessToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionId: tokens.sessionId,
      isNewUser,
      isOnboardingCompleted,
      user: {
        id: existingPatient.id,
        name: existingPatient.fullName || `User ${existingPatient.mobile}`,
        mobile: existingPatient.mobile || "",
        role: "patient",
      },
    };
  }

  async refreshToken(payload) {
    const data = await validateSchema(refreshTokenSchema, payload);
    const refreshPayload = JwtUtils.verifyRefreshToken(data.refreshToken);
    const tokenHash = hashToken(data.refreshToken);
    const activeSession = await sessionRepository.findActiveByRefreshTokenHash(tokenHash);

    if (!activeSession || activeSession.id !== refreshPayload.sessionId) {
      throw new UnauthorizedException(errorConstants.INVALID_REFRESH_TOKEN);
    }

    const existingPatient = await patientRepository.findById(activeSession.userId);

    if (!existingPatient) {
      throw new UnauthorizedException(errorConstants.INVALID_REFRESH_TOKEN);
    }

    assertPatientCanAuthenticate(existingPatient);

    const tokens = createTokenPair(existingPatient, activeSession.id);
    await sessionRepository.rotateRefreshToken(activeSession.id, {
      refreshTokenExpiresAt: parseDurationToDate(env.jwtRefreshExpiresIn),
      refreshTokenHash: hashToken(tokens.refreshToken),
    });

    return {
      ...tokens,
      expiresIn: env.jwtAccessExpiresIn,
      refreshExpiresIn: env.jwtRefreshExpiresIn,
      tokenType: responseConstants.TOKEN_TYPE,
    };
  }

  async getPatientById(id) {
    const params = await validateSchema(idParamSchema, { id });
    const existingPatient = await patientRepository.findById(params.id);

    if (!existingPatient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    return sanitizePatient(existingPatient);
  }

  async getPatientList(payload) {
    const filters = await validateSchema(listPatientsQuerySchema, payload);
    const { rows, total } = await patientRepository.findAll(filters);

    return {
      items: (Array.isArray(rows) ? rows : []).map(sanitizePatient),
      limit: filters.limit,
      page: filters.page,
      total,
    };
  }

  async updatePatient(id, payload) {
    const params = await validateSchema(idParamSchema, { id });
    const data = await validateSchema(updatePatientSchema, payload);
    const existingPatient = await patientRepository.findById(id);
    if (
      payload.profileImageKey &&
      existingPatient.profileImageKey &&
      payload.profileImageKey !== existingPatient.profileImageKey
    ) {
      await objectStorageService.deleteFile(existingPatient.profileImageKey);
    }
    if (data.email) {
      const patientWithEmail = await patientRepository.findByEmailExcludingId(
        data.email,
        params.id,
      );
      if (patientWithEmail) {
        throw new AlreadyExistsException(errorConstants.EMAIL_ALREADY_EXISTS);
      }
    }

    if (data.password) {
      data.password = await bcrypt.hash(data.password, 10);
    }

    const updatedPatient = await patientRepository.updateById(params.id, data);

    if (!updatedPatient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    const sanitized = sanitizePatient(updatedPatient);

    return {
      ...sanitized,
      patientData: sanitized,
    };
  }

  async deletePatient(id) {
    const params = await validateSchema(idParamSchema, { id });

    // Revoke all sessions for this patient on deletion
    await sessionRepository.deleteByPatientId(params.id);

    const deletedPatient = await patientRepository.softDeleteById(params.id);

    if (!deletedPatient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    return sanitizePatient(deletedPatient);
  }

  async permanentDeletePatient(id) {
    const params = await validateSchema(idParamSchema, { id });

    await sessionRepository.deleteByPatientId(params.id);
    await documentRepository.deleteByPatientId(params.id);

    const deletedPatient = await patientRepository.hardDeleteById(params.id);

    if (!deletedPatient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    return sanitizePatient(deletedPatient);
  }

  async logoutPatient(sessionId) {
    const params = await validateSchema(idParamSchema, { id: sessionId });
    const loggedOutSession = await sessionRepository.revokeById(params.id);

    if (!loggedOutSession) {
      throw new NotFoundException(errorConstants.SESSION_NOT_FOUND);
    }

    return loggedOutSession;
  }

  async getPatientProfile(userId) {
    if (!userId) {
      throw new UnauthorizedException(errorConstants.UNAUTHORIZED);
    }
    const params = await validateSchema(idParamSchema, { id: userId });
    const existingPatient = await patientRepository.findById(params.id);

    if (!existingPatient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    return sanitizePatient(existingPatient);
  }
}

module.exports = new PatientService();
