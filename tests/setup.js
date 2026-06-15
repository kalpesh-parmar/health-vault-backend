// Test environment setup
// Provide minimal env vars needed for module loading
process.env.AI_MODEL = process.env.AI_MODEL || "qwen3-vl:latest";
process.env.AI_BASE_URL = process.env.AI_BASE_URL || "http://localhost:11434";
process.env.AI_API_KEY = process.env.AI_API_KEY || "";
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://test:test@localhost:5432/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
process.env.STORAGE_PROVIDER = process.env.STORAGE_PROVIDER || "gcp";
process.env.GCP_STORAGE_BUCKET = process.env.GCP_STORAGE_BUCKET || "test-bucket";
