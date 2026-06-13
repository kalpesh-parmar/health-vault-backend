// Test environment setup
// Provide minimal env vars needed for module loading
process.env.AI_MODEL = process.env.AI_MODEL || "gemini-2.5-flash-test";
process.env.AI_BASE_URL = process.env.AI_BASE_URL || "https://generativelanguage.googleapis.com";
process.env.AI_API_KEY = process.env.AI_API_KEY || "test-key";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || "gcp";
process.env.GCP_STORAGE_BUCKET = process.env.GCP_STORAGE_BUCKET || "test-bucket";
