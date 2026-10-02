const crypto = require("crypto");
const { getAgeFromDateOfBirth } = require("../helpers/dateHelper");

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
    userName: _userName,
    phone: _phone,
    age: _age,
    ...safePatient
  } = patient;

  safePatient.age = getAgeFromDateOfBirth(safePatient.dateOfBirth);

  return safePatient;
}

function normalizeLanguage(lang) {
  if (!lang) return "english";
  const clean = String(lang).toLowerCase().trim();
  if (clean === "en" || clean === "eng" || clean === "english") return "english";
  if (clean === "gu" || clean === "guj" || clean === "gujarati") return "gujarati";
  if (clean === "hi" || clean === "hin" || clean === "hindi") return "hindi";
  if (clean === "mr" || clean === "mar" || clean === "marathi") return "marathi";
  if (clean === "ta" || clean === "tam" || clean === "tamil") return "tamil";

  const valid = ["english", "gujarati", "hindi", "marathi", "tamil"];
  if (valid.includes(clean)) return clean;
  return "english";
}

function stripReasoningTags(text) {
  if (!text || typeof text !== "string") return "";
  return text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
}

function isValidClinicalSummary(text, _patientName) {
  if (!text || typeof text !== "string") return false;
  const clean = text.trim();
  if (clean.length < 5) return false;
  const lower = clean.toLowerCase();
  if (
    lower.includes("unable to generate") ||
    lower.includes("not available") ||
    lower.includes("no medical summary") ||
    lower.includes("error processing")
  ) {
    return false;
  }
  return true;
}

function normalizePhoneNumber(payload = {}) {
  const inputMobile = payload.mobile ? String(payload.mobile).trim() : null;
  const inputCountryCode = payload.countryCode ? String(payload.countryCode).trim() : null;

  if (!inputMobile) {
    let formattedCountryCode = inputCountryCode;
    if (formattedCountryCode && !formattedCountryCode.startsWith("+")) {
      formattedCountryCode = `+${formattedCountryCode.replace(/[^\d]/g, "")}`;
    }
    return {
      mobile: null,
      countryCode: formattedCountryCode || null,
    };
  }

  const cleaned = inputMobile.replace(/[^\d+]/g, "");

  let mobile = cleaned;
  let countryCode = inputCountryCode;

  if (cleaned.startsWith("+")) {
    const digitsOnly = cleaned.slice(1);
    if (digitsOnly.length > 10) {
      mobile = digitsOnly.slice(-10);
      countryCode = `+${digitsOnly.slice(0, digitsOnly.length - 10)}`;
    } else {
      mobile = digitsOnly;
    }
  } else if (cleaned.length > 10) {
    mobile = cleaned.slice(-10);
    countryCode = `+${cleaned.slice(0, cleaned.length - 10)}`;
  } else {
    mobile = cleaned;
  }

  if (countryCode && !countryCode.startsWith("+")) {
    const digitsCode = countryCode.replace(/[^\d]/g, "");
    countryCode = digitsCode ? `+${digitsCode}` : countryCode;
  }

  return {
    mobile: mobile || null,
    countryCode: countryCode || null,
  };
}

module.exports = {
  addMinutes,
  generateNumericPatientCode,
  generateOtp,
  hashToken,
  parseDurationToDate,
  sanitizePatient,
  normalizeLanguage,
  stripReasoningTags,
  isValidClinicalSummary,
  normalizePhoneNumber,
};
