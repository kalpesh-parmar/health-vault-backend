const { drizzle } = require("drizzle-orm/node-postgres");
const { Pool, types } = require("pg");
const { env } = require("./env");

require("dotenv").config({ quiet: true });

// Force node-postgres to parse TIMESTAMP WITHOUT TIMEZONE (OID 1114) as UTC
types.setTypeParser(1114, (stringValue) => {
  if (!stringValue) return null;
  return new Date(stringValue.replace(" ", "T") + "Z");
});

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

// Dynamically determine SSL configuration based on host/environment
const isLocalhost =
  env.databaseUrl.includes("localhost") ||
  env.databaseUrl.includes("127.0.0.1") ||
  env.databaseUrl.includes("postgres:");
const sslConfig = isLocalhost ? false : { rejectUnauthorized: false };

const pool = new Pool({
  connectionString: env.databaseUrl,
  idleTimeoutMillis: env.dbIdleTimeoutMs,
  max: env.dbPoolMax,
  ssl: sslConfig,
});

const db = drizzle(pool);

pool.on("error", (error) => {
  console.error("Unexpected database client error", error);
});

module.exports = { db, pool };
