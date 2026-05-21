const crypto = require("crypto");

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function generateNumericPatientCode() {
  const min = 10000;
  const max = 999999;
  const randomNumber = Math.floor(Math.random() * (max - min + 1)) + min;

  return randomNumber.toString();
}

function generateOtp(length = 6) {
  const min = 10 ** (length - 1);
  const max = 10 ** length - 1;
  return String(Math.floor(Math.random() * (max - min + 1)) + min);
}

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function parseDurationToDate(duration) {
  const match = /^(\d+)([smhd])$/.exec(duration);

  if (!match) {
    return addMinutes(new Date(), 7 * 24 * 60);
  }

  const amount = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    d: 24 * 60,
    h: 60,
    m: 1,
    s: 1 / 60,
  };

  return addMinutes(new Date(), amount * multipliers[unit]);
}

function sanitizePatient(patient) {
  if (!patient) {
    return null;
  }

  const {
    blockedAt: _blockedAt,
    loginAttempts: _loginAttempts,
    otp: _otp,
    otpExpiredDateTime: _otpExpiredDateTime,
    otpSendDateTime: _otpSendDateTime,
    otpVerifiedAt: _otpVerifiedAt,
    password: _password,
    ...safePatient
  } = patient;

  return safePatient;
}

module.exports = {
  addMinutes,
  generateNumericPatientCode,
  generateOtp,
  hashToken,
  parseDurationToDate,
  sanitizePatient,
};
