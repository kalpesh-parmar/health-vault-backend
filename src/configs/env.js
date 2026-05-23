require("dotenv").config({ quiet: true });

function numberFromEnv(key, fallback) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : fallback;
}

function booleanFromEnv(key, fallback = false) {
  if (process.env[key] === undefined) {
    return fallback;
  }

  return process.env[key] === "true";
}

const env = Object.freeze({
  appName: process.env.APP_NAME || "Health Vault",
  appUrl: process.env.APP_URL || "http://localhost:3000",
  awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID,
  awsRegion: process.env.AWS_REGION || "us-east-1",
  apiKey: process.env.CHATBOT_API_KEY,
  awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
  chatbotAPIKey: process.env.CHATBOT_API_KEY,
  databaseUrl: process.env.DATABASE_URL,
  dbIdleTimeoutMs: numberFromEnv("DB_IDLE_TIMEOUT_MS", 30000),
  dbPoolMax: numberFromEnv("DB_POOL_MAX", 10),
  emailEnabled: booleanFromEnv("EMAIL_ENABLED", true),
  emailFrom: process.env.EMAIL_FROM || "no-reply@health-vault.local",
  firebaseCredentialsBase64: process.env.FIREBASE_CREDENTIALS_BASE64,
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID,
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtAudience: process.env.JWT_AUDIENCE,
  jwtIssuer: process.env.JWT_ISSUER || "health-vault",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  jwtSecret: process.env.JWT_SECRET,
  maxLoginAttempts: numberFromEnv("MAX_LOGIN_ATTEMPTS", 3),
  nodeEnv: process.env.NODE_ENV || "development",
  otpExpiryMinutes: numberFromEnv("OTP_EXPIRY_MINUTES", 10),
  passwordResetWindowMinutes: numberFromEnv("PASSWORD_RESET_WINDOW_MINUTES", 15),
  patientDocumentsBucket: process.env.PATIENT_DOCUMENTS_BUCKET || "patient-documents",
  port: numberFromEnv("PORT", 8000),
  rateLimitMax: numberFromEnv("RATE_LIMIT_MAX", 100),
  rateLimitWindowMs: numberFromEnv("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
  smtpHost: process.env.SMTP_HOST,
  smtpPassword: process.env.SMTP_PASSWORD,
  smtpPort: numberFromEnv("SMTP_PORT", 587),
  smtpSecure: booleanFromEnv("SMTP_SECURE", false),
  smtpUser: process.env.SMTP_USER,
  ollamaUrl: process.env.OLLAMA_URL,
  ocrModel: process.env.OCR_MODEL,
  chatModel: process.env.CHAT_MODEL,
  codeModel: process.env.CODE_MODEL,
  visionModel: process.env.VISION_MODEL,
  userProfileImagesBucket: process.env.USER_PROFILE_IMAGES_BUCKET || "user-profile-images",
});

module.exports = { env };
