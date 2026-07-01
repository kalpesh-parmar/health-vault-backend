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
const userOnboardingRepository = require("../repositories/userOnboardingRepository");
const {
  generateNumericPatientCode,
  hashToken,
  parseDurationToDate,
  sanitizePatient,
} = require("../utils/commonUtils");
const JwtUtils = require("../utils/jwtUtils");
const {
  idParamSchema,
  listPatientsQuerySchema,
  refreshTokenSchema,
  updatePatientSchema,
  validateSchema,
} = require("../validations");
const { verifyFirebaseToken } = require("../configs/firebase");
const { socialLogin, authFailureSchema } = require("../validations/patientValidation");
const objectStorageService = require("./objectStorageService");
const authProviderRepository = require("../repositories/authProviderRepository");
const loginAttemptRepository = require("../repositories/loginAttemptRepository");

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
    await authProviderRepository.softDeleteByUserId(params.id);

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
    await authProviderRepository.hardDeleteByUserId(params.id);

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

  async socialLogin(payload) {
    const data = await validateSchema(socialLogin, payload);
    const { provider, loginType, firebaseIdToken, deviceToken } = data;

    let decodedToken;
    if (env.enableDummyAuth && firebaseIdToken && firebaseIdToken.startsWith("dummy-")) {
      decodedToken = {
        uid: `mock-uid-${provider}-${firebaseIdToken}`,
        email: `${provider}-mockuser@example.com`,
        name: `Mock ${provider.charAt(0).toUpperCase() + provider.slice(1)}User`,
        phone_number: loginType === "mobile" && provider === "mobile" ? "+911111111111" : null,
      };
    } else {
      if (!firebaseIdToken) {
        throw new InvalidRequestException("Firebase ID token is required");
      }
      try {
        decodedToken = await verifyFirebaseToken(firebaseIdToken);
      } catch (error) {
        console.error("Firebase ID Token verification failed:", error);
        throw new UnauthorizedException("Invalid Firebase token");
      }
    }

    let mobile = null;
    let countryCode = null;
    if (decodedToken.phone_number) {
      const cleaned = decodedToken.phone_number.replace(/[^+\d]/g, "");
      mobile = cleaned;
      if (cleaned.startsWith("+") && cleaned.length > 10) {
        mobile = cleaned.slice(-10);
        countryCode = cleaned.slice(0, cleaned.length - 10);
      }
    }

    const email = decodedToken.email || null;
    let firstName = null;
    let lastName = null;
    if (decodedToken.name) {
      const nameParts = decodedToken.name.trim().split(/\s+/);
      firstName = nameParts[0] || null;
      lastName = nameParts.length > 1 ? nameParts.slice(1).join(" ") : null;
    }
    const firebaseUid = decodedToken.uid;
    const providerUserId = firebaseUid; // Or decodedToken.sub

    const identifier = firebaseUid;

    // BLOCK CHECK
    const attemptRecord = await loginAttemptRepository.findAttempt(identifier, provider, loginType);

    if (attemptRecord?.blockedUntil) {
      if (new Date(attemptRecord.blockedUntil) > new Date()) {
        const remainingSeconds = Math.ceil(
          (new Date(attemptRecord.blockedUntil) - new Date()) / 1000,
        );

        throw new UnauthorizedException({
          blocked: true,
          message: `User is blocked try again after ${new Date(attemptRecord.blockedUntil).toLocaleString()}`,
          remainingSeconds,
        });
      } else {
        const patientToUnblock = await patientRepository.findByFirebaseUid(firebaseUid);
        if (patientToUnblock && patientToUnblock.status === USER_STATUS.BLOCKED) {
          await patientRepository.updateById(patientToUnblock.id, { status: USER_STATUS.ACTIVE });
        }
      }
    }

    // FIND EXISTING PROVIDER LINK
    let authRec = await authProviderRepository.findByProvider(provider, providerUserId);
    let patientUser = null;

    if (authRec) {
      patientUser = await patientRepository.findById(authRec.userId);
    }

    let isNewUser = false;
    // ACCOUNT LINKING / CREATE USER
    if (!patientUser) {
      if (email) {
        patientUser = await patientRepository.findByEmail(email);
      }
      if (!patientUser && mobile) {
        patientUser = await patientRepository.findByMobile(mobile);
      }
      if (!patientUser && firebaseUid) {
        patientUser = await patientRepository.findByFirebaseUid(firebaseUid);
      }

      if (patientUser) {
        const existingProvider = await authProviderRepository.findByProvider(
          provider,
          providerUserId,
        );

        if (!existingProvider) {
          await authProviderRepository.create({
            userId: patientUser.id,
            provider,
            providerUserId: providerUserId,
            email: email,
          });
        }
      } else {
        isNewUser = true;

        const patientCode = await createUniquePatientCode();

        const isMobileVerified = provider === "mobile" && loginType === "mobile" && !!mobile;
        const socialProviders = ["google", "facebook", "microsoft"];
        const isEmailVerified = socialProviders.includes(provider) && loginType === "social";

        patientUser = await patientRepository.create({
          patientCode,
          firebaseUid,
          mobile: mobile,
          countryCode: countryCode,
          email: email,
          firstName: firstName,
          lastName: lastName,
          fullName: decodedToken.name || null,
          isActive: true,
          status: USER_STATUS.ACTIVE,
          isVerified: true,
          isMobileVerified: isMobileVerified,
          isEmailVerified: isEmailVerified,
          onboardingCompleted: false,
          lastLoginAt: new Date(),
        });

        await authProviderRepository.create({
          userId: patientUser.id,
          provider,
          providerUserId: providerUserId,
          email: email,
        });
      }
    } else {
      assertPatientCanAuthenticate(patientUser);
    }
    // SUCCESS LOGIN
    const updateData = {
      lastLoginAt: new Date(),
      firebaseUid,
    };

    if (provider === "mobile" && loginType === "mobile" && !!mobile) {
      updateData.isMobileVerified = true;
      if (!patientUser.mobile) {
        updateData.mobile = mobile;
        updateData.countryCode = countryCode;
      }
    }

    const socialProvidersList = ["google", "facebook", "microsoft"];
    if (socialProvidersList.includes(provider) && loginType === "social") {
      updateData.isEmailVerified = true;
    }

    patientUser = await patientRepository.updateById(patientUser.id, updateData);

    await loginAttemptRepository.resetAttempts(identifier, provider, loginType);

    const tokens = await persistSession(patientUser, deviceToken);

    const isOnboardingCompleted = !!(
      patientUser.firstName &&
      patientUser.firstName !== "User" &&
      patientUser.lastName &&
      patientUser.gender &&
      patientUser.dateOfBirth
    );

    if (isOnboardingCompleted !== patientUser.onboardingCompleted) {
      await patientRepository.updateById(patientUser.id, {
        onboardingCompleted: isOnboardingCompleted,
      });

      patientUser.onboardingCompleted = isOnboardingCompleted;
    }

    // Get onboarding state for resumption
    const onboardingState = isOnboardingCompleted
      ? null
      : await userOnboardingRepository.findByUserId(patientUser.id);

    return {
      success: true,
      token: tokens.accessToken,
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      sessionId: tokens.sessionId,
      isNewUser,
      isOnboardingCompleted,
      onboardingStep: onboardingState?.data?.currentStep || (isNewUser ? "ASK_LANGUAGE" : null),
      onboardingData: onboardingState?.data || null,
      user: {
        id: patientUser.id,
        name: patientUser.fullName || `User ${patientUser.mobile || patientUser.email || ""}`,
        mobile: patientUser.mobile || "",
        email: patientUser.email || "",
        role: "patient",
      },
    };
  }
  async reportAuthFailure(payload) {
    const data = await validateSchema(authFailureSchema, payload);

    const { identifier, provider, loginType } = data;

    const attemptRecord = await loginAttemptRepository.incrementFailedAttempt(
      identifier,
      provider,
      loginType,
    );

    if (attemptRecord.failedAttempts === 1 && !attemptRecord.blockedUntil) {
      const patientRecord = await patientRepository.findByFirebaseUid(identifier);
      if (patientRecord && patientRecord.status === USER_STATUS.BLOCKED) {
        await patientRepository.updateById(patientRecord.id, { status: USER_STATUS.ACTIVE });
      }
    }

    if (attemptRecord.failedAttempts >= env.maxLoginAttempts) {
      const blockedUntil = new Date(Date.now() + env.lockTimeMinutes * 60 * 1000);

      await loginAttemptRepository.blockMethod(attemptRecord.id, blockedUntil);

      const patientRecord = await patientRepository.findByFirebaseUid(identifier);
      if (patientRecord) {
        await patientRepository.updateById(patientRecord.id, { status: USER_STATUS.BLOCKED });
      }

      throw new UnauthorizedException({
        blocked: true,
        message: `User is blocked try again after ${blockedUntil.toLocaleString()}`,
        blockedUntil,
        remainingAttempts: 0,
      });
    }

    return {
      success: true,
      blocked: false,
      failedAttempts: attemptRecord.failedAttempts,
      remainingAttempts: 3 - attemptRecord.failedAttempts,
    };
  }
}

module.exports = new PatientService();
