// Test setup file for Jest
process.env.NODE_ENV = "test";
process.env.DATABASE_URL =
  process.env.DATABASE_URL || "postgres://postgres:postgres@localhost:5432/health_vault_test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-jwt-secret-key-32-chars-minimum";
process.env.AI_MODEL = process.env.AI_MODEL || "qwen3:32b";
process.env.AI_BASE_URL = process.env.AI_BASE_URL || "http://localhost:11434";
process.env.PATIENT_DOCUMENTS_BUCKET = process.env.PATIENT_DOCUMENTS_BUCKET || "test-bucket";
