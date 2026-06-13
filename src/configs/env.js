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

const env = Object.freeze({
  appName: process.env.APP_NAME || "Health Vault",
  appUrl: process.env.APP_URL || "http://localhost:3000",
  port: numberFromEnv("PORT", 8080),
  nodeEnv: process.env.NODE_ENV || "development",

  // Database
  databaseUrl: stringFromEnv("DATABASE_URL"),
  dbIdleTimeoutMs: numberFromEnv("DB_IDLE_TIMEOUT_MS", 30000),
  dbPoolMax: numberFromEnv("DB_POOL_MAX", 10),

  // JWT
  jwtSecret: stringFromEnv("JWT_SECRET"),
  jwtAccessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
  jwtRefreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
  jwtIssuer: process.env.JWT_ISSUER || "health-vault",
  jwtAudience: stringFromEnv("JWT_AUDIENCE"),

  // Security / Limits
  maxLoginAttempts: numberFromEnv("MAX_LOGIN_ATTEMPTS", 3),
  otpExpiryMinutes: numberFromEnv("OTP_EXPIRY_MINUTES", 10),
  passwordResetWindowMinutes: numberFromEnv("PASSWORD_RESET_WINDOW_MINUTES", 15),
  rateLimitMax: numberFromEnv("RATE_LIMIT_MAX", 100),
  rateLimitWindowMs: numberFromEnv("RATE_LIMIT_WINDOW_MS", 15 * 60 * 1000),

  // Email / SMTP
  emailEnabled: booleanFromEnv("EMAIL_ENABLED", true),
  emailFrom: process.env.EMAIL_FROM || "no-reply@health-vault.local",
  smtpHost: process.env.SMTP_HOST,
  smtpPort: numberFromEnv("SMTP_PORT", 587),
  smtpSecure: booleanFromEnv("SMTP_SECURE", false),
  smtpUser: process.env.SMTP_USER,
  smtpPassword: process.env.SMTP_PASSWORD,

  // Storage Buckets & Providers
  storageProvider: process.env.STORAGE_PROVIDER || "s3",
  patientDocumentsBucket: process.env.PATIENT_DOCUMENTS_BUCKET || "patient-documents",
  userProfileImagesBucket: process.env.USER_PROFILE_IMAGES_BUCKET || "user-profile-images",

  // AWS S3
  awsAccessKeyId: stringFromEnv("AWS_ACCESS_KEY_ID"),
  awsSecretAccessKey: stringFromEnv("AWS_SECRET_ACCESS_KEY"),
  awsRegion: process.env.AWS_REGION || "us-east-1",

  // GCP Storage
  gcpProjectId: stringFromEnv("GCP_PROJECT_ID"),
  gcpStorageBucket:
    stringFromEnv("GCP_STORAGE_BUCKET") || stringFromEnv("PATIENT_DOCUMENTS_BUCKET"),
  gcpCredentialsBase64: stringFromEnv("GCP_CREDENTIALS_BASE64"),

  // Firebase
  firebaseProjectId: stringFromEnv("FIREBASE_PROJECT_ID"),
  firebaseCredentialsBase64: stringFromEnv("FIREBASE_CREDENTIALS_BASE64"),

  // AI Settings (Local & Google Cloud / External)
  aiApiKey: stringFromEnv("AI_API_KEY"),
  aiBaseUrl: stringFromEnv("AI_BASE_URL"),
  aiModel: stringFromEnv("AI_MODEL"),
  aiServiceUrl: process.env.AI_SERVICE_URL || "http://127.0.0.1:8000",
  aiTimeoutMs: numberFromEnv("AI_TIMEOUT_MS", 90 * 1000),
  aiMaxRetries: numberFromEnv("AI_MAX_RETRIES", 2),
  aiPageConcurrency: numberFromEnv("AI_PAGE_CONCURRENCY", 4),
  aiMaxOutputTokens: numberFromEnv("AI_MAX_OUTPUT_TOKENS", 8192),
  aiMaxInlineBytes: numberFromEnv("AI_MAX_INLINE_BYTES", 18 * 1024 * 1024),
  aiMinTextChars: numberFromEnv("AI_MIN_TEXT_CHARS", 8),
  aiMinConfidence: Number.isFinite(Number(process.env.AI_MIN_CONFIDENCE))
    ? Number(process.env.AI_MIN_CONFIDENCE)
    : 0.35,

  // Local/Legacy AI Settings
  apiKey: stringFromEnv("CHATBOT_API_KEY"),
  chatbotAPIKey: stringFromEnv("CHATBOT_API_KEY"),
  ollamaUrl: process.env.OLLAMA_URL,
  ocrModel: process.env.OCR_MODEL,
  chatModel: process.env.CHAT_MODEL,
  codeModel: process.env.CODE_MODEL,
  visionModel: process.env.VISION_MODEL,

  // Embedding & Reminders
  embeddingModel: process.env.AI_EMBEDDING_MODEL || "all-MiniLM-L6-v2",
  reminderAfterMinutes: numberFromEnv("REMINDER_AFTER_MINUTES", 10),
  refillRemainingQuantity: numberFromEnv("REFILL_REMAINING_QUANTITY", 3),
  afterReminderNotificationMinutes: numberFromEnv("AFTER_REMINDER_NOTIFICATION_MINUTES", 15),
});

module.exports = { env };
