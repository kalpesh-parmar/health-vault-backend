const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, "../../.env"), quiet: true });

function numberFromEnv(key, defaultValue) {
  const value = Number(process.env[key]);
  return Number.isFinite(value) ? value : defaultValue;
}

function booleanFromEnv(key, defaultValue = false) {
  if (process.env[key] === undefined) {
    return defaultValue;
  }
  return process.env[key] === "true";
}

function stringFromEnv(key) {
  const value = process.env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

// function hasAwsCredentials() {
//   return Boolean(
//     (stringFromEnv("AWS_ACCESS_KEY_ID") && stringFromEnv("AWS_SECRET_ACCESS_KEY")) ||
//     stringFromEnv("AWS_PROFILE") ||
//     stringFromEnv("AWS_WEB_IDENTITY_TOKEN_FILE"),
//   );
// }

// function hasGcpCredentials() {
//   return Boolean(
//     stringFromEnv("GCP_CREDENTIALS_BASE64") || stringFromEnv("GOOGLE_APPLICATION_CREDENTIALS"),
//   );
// }

// function resolveStorageProvider() {
//   const configured = (process.env.STORAGE_PROVIDER || "auto").trim().toLowerCase();
//   const hasGcpConfig = Boolean(
//     stringFromEnv("GCP_STORAGE_BUCKET") || stringFromEnv("PATIENT_DOCUMENTS_BUCKET"),
//   );
//   const hasS3Config = Boolean(stringFromEnv("PATIENT_DOCUMENTS_BUCKET"));

//   if (configured === "auto") {
//     if (hasGcpConfig && hasGcpCredentials()) return "gcp";
//     if (hasS3Config && hasAwsCredentials()) return "s3";
//     throw new Error(
//       "Storage is not configured. Set STORAGE_PROVIDER=s3 or STORAGE_PROVIDER=gcp with the required bucket and credentials.",
//     );
//   }

//   if (!["s3", "gcp"].includes(configured)) {
//     throw new Error("STORAGE_PROVIDER must be one of: auto, s3, gcp");
//   }

//   return configured;
// }

const env = Object.freeze({
  appName: process.env.APP_NAME || "Health Vault",
  appUrl: process.env.APP_URL || "http://localhost:3000",
  aiApiKey: stringFromEnv("AI_API_KEY"),
  aiBaseUrl: stringFromEnv("AI_BASE_URL"),
  aiMaxInlineBytes: numberFromEnv("AI_MAX_INLINE_BYTES", 18 * 1024 * 1024),
  aiMaxOutputTokens: numberFromEnv("AI_MAX_OUTPUT_TOKENS", 8192),
  aiMaxRetries: numberFromEnv("AI_MAX_RETRIES", 2),
  aiMinConfidence: Number.isFinite(Number(process.env.AI_MIN_CONFIDENCE))
    ? Number(process.env.AI_MIN_CONFIDENCE)
    : 0.35,
  aiMinTextChars: numberFromEnv("AI_MIN_TEXT_CHARS", 8),
  aiServiceUrl: process.env.AI_SERVICE_URL || "http://127.0.0.1:8000",
  aiModel: stringFromEnv("AI_MODEL"),
  aiPageConcurrency: numberFromEnv("AI_PAGE_CONCURRENCY", 4),
  aiTimeoutMs: numberFromEnv("AI_TIMEOUT_MS", 90 * 1000),
  awsAccessKeyId: stringFromEnv("AWS_ACCESS_KEY_ID"),
  awsRegion: process.env.AWS_REGION || "us-east-1",
  awsSecretAccessKey: stringFromEnv("AWS_SECRET_ACCESS_KEY"),
  databaseUrl: stringFromEnv("DATABASE_URL"),
  dbIdleTimeoutMs: numberFromEnv("DB_IDLE_TIMEOUT_MS", 30000),
  dbPoolMax: numberFromEnv("DB_POOL_MAX", 10),
  emailEnabled: booleanFromEnv("EMAIL_ENABLED", true),
  emailFrom: process.env.EMAIL_FROM || "no-reply@health-vault.local",
  embeddingModel: process.env.AI_EMBEDDING_MODEL || "all-MiniLM-L6-v2",
  firebaseCredentialsBase64: stringFromEnv("FIREBASE_CREDENTIALS_BASE64"),
  firebaseProjectId: stringFromEnv("FIREBASE_PROJECT_ID"),
  gcpCredentialsBase64: stringFromEnv("GCP_CREDENTIALS_BASE64"),
  gcpProjectId: stringFromEnv("GCP_PROJECT_ID"),
  gcpStorageBucket:
    stringFromEnv("GCP_STORAGE_BUCKET") || stringFromEnv("PATIENT_DOCUMENTS_BUCKET"),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtAudience: stringFromEnv("JWT_AUDIENCE"),
  jwtIssuer: process.env.JWT_ISSUER || "health-vault",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  jwtSecret: stringFromEnv("JWT_SECRET"),
  maxLoginAttempts: numberFromEnv("MAX_LOGIN_ATTEMPTS", 3),
  nodeEnv: process.env.NODE_ENV || "development",
  otpExpiryMinutes: numberFromEnv("OTP_EXPIRY_MINUTES", 10),
  passwordResetWindowMinutes: numberFromEnv("PASSWORD_RESET_WINDOW_MINUTES", 15),
  patientDocumentsBucket: process.env.PATIENT_DOCUMENTS_BUCKET || "patient-documents",
  port: numberFromEnv("PORT", 8080),
  reminderAfterMinutes: numberFromEnv("REMINDER_AFTER_MINUTES", 10),
  rateLimitMax: numberFromEnv("RATE_LIMIT_MAX", 100),
  rateLimitWindowMs: numberFromEnv("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),
  refillRemainingQuantity: numberFromEnv("REFILL_REMAINING_QUANTITY", 3),
  smtpHost: process.env.SMTP_HOST,
  smtpPassword: process.env.SMTP_PASSWORD,
  storageProvider: process.env.STORAGE_PROVIDER || "s3",
  smtpPort: numberFromEnv("SMTP_PORT", 587),
  smtpSecure: booleanFromEnv("SMTP_SECURE", false),
  smtpUser: process.env.SMTP_USER,
  userProfileImagesBucket: process.env.USER_PROFILE_IMAGES_BUCKET || "user-profile-images",
  afterReminderNotificationMinutes: numberFromEnv("AFTER_REMINDER_NOTIFICATION_MINUTES", 15),
  // refillAlertBeforeDays: numberFromEnv("REFILL_ALERT_BEFORE_DAYS", 2),
});

module.exports = { env };
