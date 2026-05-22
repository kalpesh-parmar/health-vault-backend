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
  addMinutes,
  generateNumericPatientCode,
  generateOtp,
  hashToken,
  parseDurationToDate,
  sanitizePatient,
} = require("../utils/commonUtils");
const JwtUtils = require("../utils/jwtUtils");
const {
  createPatientSchema,
  emailOnlySchema,
  idParamSchema,
  listPatientsQuerySchema,
  loginPatientSchema,
  refreshTokenSchema,
  resetPasswordSchema,
  updatePatientSchema,
  validateSchema,
  verifyOtpSchema,
} = require("../validations");
const emailService = require("./emailService");
// const { PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require("@aws-sdk/client-s3");
// const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const s3service = require("./s3service");

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
    accessToken: JwtUtils.generateAccessToken(tokenPayload, {
      subject: existingPatient.id,
    }),
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

  async loginPatient(payload) {
    const data = await validateSchema(loginPatientSchema, payload);
    const existingPatient = await patientRepository.findByEmail(data.email);

    if (!existingPatient) {
      throw new UnauthorizedException(errorConstants.INVALID_CREDENTIALS);
    }

    assertPatientCanAuthenticate(existingPatient);

    const passwordMatches = await bcrypt.compare(data.password, existingPatient.password);

    if (!passwordMatches) {
      await this.handleFailedSecurityAttempt(existingPatient);
      throw new UnauthorizedException(errorConstants.INVALID_CREDENTIALS);
    }

    const updatedPatient = await patientRepository.updateById(existingPatient.id, {
      loginAttempts: 0,
    });
    const tokens = await persistSession(updatedPatient, data.deviceToken);

    return {
      ...tokens,
      patient: sanitizePatient(updatedPatient),
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

  async createPatient(payload) {
    // const reqData = { payload };
    const data = await validateSchema(createPatientSchema, payload);
    const existingPatient = await patientRepository.findByEmail(data.email);
    if (existingPatient) {
      throw new AlreadyExistsException(errorConstants.EMAIL_ALREADY_EXISTS);
    }
    const password = await bcrypt.hash(data.password, 10);
    const patientCode = await createUniquePatientCode();
    const createdPatient = await patientRepository.create({
      ...data,
      patientCode,
      password,
      status: USER_STATUS.ACTIVE,
    });
    console.log("patientData====", createdPatient);

    return {
      patientData: sanitizePatient(createdPatient),
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
      items: rows.map(sanitizePatient),
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
      await s3service.deleteFile(existingPatient.profileImageKey);
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
    return {
      patientData: sanitizePatient(updatedPatient),
    };
  }

  async deletePatient(id) {
    const params = await validateSchema(idParamSchema, { id });
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

  async requestOtp(payload, templateName = "otpVerification") {
    const data = await validateSchema(emailOnlySchema, payload);
    console.log("data===", data);

    const existingPatient = await patientRepository.findByEmail(data.email);

    // if (!existingPatient) {
    //   throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    // }

    assertPatientCanAuthenticate(data);

    const now = new Date();
    const otp = generateOtp();
    const updatedPatient = await patientRepository.updateById(existingPatient.id, {
      otp,
      otpExpiredDateTime: addMinutes(now, env.otpExpiryMinutes),
      otpSendDateTime: now,
      otpVerifiedAt: null,
    });
    await emailService.sendOtpEmail(data, otp, templateName);

    return {
      expiresAt: updatedPatient.otpExpiredDateTime,
    };
  }

  async forgotPassword(payload) {
    return this.requestOtp(payload, "forgotPassword");
  }

  async verifyOtp(payload) {
    const data = await validateSchema(verifyOtpSchema, payload);
    const existingPatient = await patientRepository.findByEmail(data.email);

    if (!existingPatient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    assertPatientCanAuthenticate(existingPatient);

    if (!existingPatient.otp || existingPatient.otp !== data.otp) {
      await this.handleFailedSecurityAttempt(existingPatient);
      throw new InvalidRequestException(errorConstants.INVALID_OTP);
    }

    if (!existingPatient.otpExpiredDateTime || existingPatient.otpExpiredDateTime < new Date()) {
      throw new InvalidRequestException(errorConstants.OTP_EXPIRED);
    }

    const updatedPatient = await patientRepository.updateById(existingPatient.id, {
      isVerified: true,
      loginAttempts: 0,
      otp: null,
      otpExpiredDateTime: null,
      otpSendDateTime: null,
      otpVerifiedAt: new Date(),
    });

    return sanitizePatient(updatedPatient);
  }

  async resetPassword(payload) {
    const data = await validateSchema(resetPasswordSchema, payload);
    const existingPatient = await patientRepository.findByEmail(data.email);

    if (!existingPatient) {
      throw new NotFoundException(errorConstants.PATIENT_NOT_FOUND);
    }

    assertPatientCanAuthenticate(existingPatient);

    if (
      !existingPatient.otpVerifiedAt ||
      addMinutes(existingPatient.otpVerifiedAt, env.passwordResetWindowMinutes) < new Date()
    ) {
      throw new InvalidRequestException(errorConstants.OTP_NOT_VERIFIED);
    }

    const password = await bcrypt.hash(data.password, 10);
    const updatedPatient = await patientRepository.updateById(existingPatient.id, {
      loginAttempts: 0,
      otpVerifiedAt: null,
      password,
    });

    await emailService.sendPasswordResetSuccessEmail(updatedPatient);

    return sanitizePatient(updatedPatient);
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

    return existingPatient;
  }
}

module.exports = new PatientService();
