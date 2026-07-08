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

function hasAwsCredentials() {
  return Boolean(
    (stringFromEnv("AWS_ACCESS_KEY_ID") && stringFromEnv("AWS_SECRET_ACCESS_KEY")) ||
    stringFromEnv("AWS_PROFILE") ||
    stringFromEnv("AWS_WEB_IDENTITY_TOKEN_FILE"),
  );
}

function hasGcpCredentials() {
  return Boolean(
    stringFromEnv("GCP_CREDENTIALS_BASE64") || stringFromEnv("GOOGLE_APPLICATION_CREDENTIALS"),
  );
}

function resolveStorageProvider() {
  const configured = (process.env.STORAGE_PROVIDER || "auto").trim().toLowerCase();
  const hasGcpConfig = Boolean(
    stringFromEnv("GCP_STORAGE_BUCKET") || stringFromEnv("AWS_BUCKET_NAME"),
  );
  const hasS3Config = Boolean(stringFromEnv("AWS_BUCKET_NAME"));

  if (configured === "auto") {
    if (hasGcpConfig && hasGcpCredentials()) return "gcp";
    if (hasS3Config && hasAwsCredentials()) return "s3";
    throw new Error(
      "Storage is not configured. Set STORAGE_PROVIDER=s3 or STORAGE_PROVIDER=gcp with the required bucket and credentials.",
    );
  }

  if (configured === "aws") {
    return "s3";
  }

  if (!["s3", "gcp"].includes(configured)) {
    throw new Error("STORAGE_PROVIDER must be one of: auto, s3, gcp, aws");
  }

  return configured;
}

const env = Object.freeze({
  appName: process.env.APP_NAME || "Health Vault",
  appUrl: process.env.APP_URL || "http://localhost:3000",
  port: numberFromEnv("PORT", 3000),
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
  lockTimeMinutes: numberFromEnv("LOCK_TIME_MINUTES", 15),
  otpExpiryMinutes: numberFromEnv("OTP_EXPIRY_MINUTES", 10),
  passwordResetWindowMinutes: numberFromEnv("PASSWORD_RESET_WINDOW_MINUTES", 15),
  patientDocumentsBucket: process.env.PATIENT_DOCUMENTS_BUCKET || "patient-documents",
  reminderAfterMinutes: numberFromEnv("REMINDER_AFTER_MINUTES", 10),
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
  storageProvider: resolveStorageProvider(),
  awsBucketName: stringFromEnv("AWS_BUCKET_NAME"),

  // AWS S3
  awsAccessKeyId: stringFromEnv("AWS_ACCESS_KEY_ID"),
  awsSecretAccessKey: stringFromEnv("AWS_SECRET_ACCESS_KEY"),
  awsRegion: process.env.AWS_REGION || "us-east-1",

  // GCP Storage
  gcpProjectId: stringFromEnv("GCP_PROJECT_ID"),
  gcpStorageBucket: stringFromEnv("GCP_STORAGE_BUCKET") || stringFromEnv("AWS_BUCKET_NAME"),
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
  aiMaxInlineBytes: numberFromEnv("AI_MAX_INLINE_BYTES", 100 * 1024 * 1024),
  aiMinTextChars: numberFromEnv("AI_MIN_TEXT_CHARS", 8),
  aiMinConfidence: Number.isFinite(Number(process.env.AI_MIN_CONFIDENCE))
    ? Number(process.env.AI_MIN_CONFIDENCE)
    : 0.35,

  // Local/Legacy AI Settings
  apiKey: stringFromEnv("CHATBOT_API_KEY"),
  chatbotAPIKey: stringFromEnv("CHATBOT_API_KEY"),
  ollamaUrl: process.env.AI_BASE_URL,
  ocrModel: process.env.OCR_MODEL,
  chatModel: process.env.CHAT_MODEL,
  codeModel: process.env.CODE_MODEL,
  visionModel: process.env.VISION_MODEL,
  popplerPath: process.env.POPPLER_PATH,

  // Embedding & Reminders
  embeddingModel: process.env.AI_EMBEDDING_MODEL || "all-MiniLM-L6-v2",
  refillRemainingQuantity: numberFromEnv("REFILL_REMAINING_QUANTITY", 3),
  afterReminderNotificationMinutes: numberFromEnv("AFTER_REMINDER_NOTIFICATION_MINUTES", 15),
  // refillAlertBeforeDays: numberFromEnv("REFILL_ALERT_BEFORE_DAYS", 2),
  ragTopK: numberFromEnv("RAG_TOP_K", 8),

  //client Ids based on Provider
  facebookAppId: stringFromEnv("FACEBOOK_APP_ID"),
  facebookAppSecret: stringFromEnv("FACEBOOK_APP_SECRET"),
  googleClientId: stringFromEnv("GOOGLE_CLIENT_ID"),
  googleWebClientId: stringFromEnv("GOOGLE_WEB_CLIENT_ID"),
  microsoftClientId: stringFromEnv("MICROSOFT_CLIENT_ID"),
  microsoftTenantId: stringFromEnv("MICROSOFT_TENANT_ID") || "common",
  enableDummyAuth: booleanFromEnv("ENABLE_DUMMY_AUTH", true),
});

function validateEnv(config) {
  const missing = [];

  if (!config.aiModel) missing.push("AI_MODEL");
  if (!config.aiBaseUrl) missing.push("AI_BASE_URL");
  if (!config.databaseUrl) missing.push("DATABASE_URL");
  if (!config.jwtSecret) missing.push("JWT_SECRET");

  if (config.storageProvider === "gcp") {
    if (!config.gcpStorageBucket) missing.push("GCP_STORAGE_BUCKET or PATIENT_DOCUMENTS_BUCKET");
    if (!hasGcpCredentials())
      missing.push("GCP_CREDENTIALS_BASE64 or GOOGLE_APPLICATION_CREDENTIALS");
  }

  if (config.storageProvider === "s3") {
    if (!config.patientDocumentsBucket) missing.push("PATIENT_DOCUMENTS_BUCKET");
    if (!config.awsRegion) missing.push("AWS_REGION");
  }

  if (missing.length) {
    throw new Error(`Missing required configuration: ${missing.join(", ")}`);
  }

  if (config.aiTimeoutMs <= 0) throw new Error("AI_TIMEOUT_MS must be greater than zero");
  if (config.aiMaxRetries < 0) throw new Error("AI_MAX_RETRIES must be zero or greater");
  if (config.aiMaxOutputTokens <= 0)
    throw new Error("AI_MAX_OUTPUT_TOKENS must be greater than zero");
  if (config.aiPageConcurrency <= 0)
    throw new Error("AI_PAGE_CONCURRENCY must be greater than zero");
  if (config.aiMaxInlineBytes <= 0)
    throw new Error("AI_MAX_INLINE_BYTES must be greater than zero");
  if (config.aiMinTextChars < 0) throw new Error("AI_MIN_TEXT_CHARS must be zero or greater");
  if (config.aiMinConfidence < 0 || config.aiMinConfidence > 1) {
    throw new Error("AI_MIN_CONFIDENCE must be between 0 and 1");
  }
}

validateEnv(env);

module.exports = { env };
