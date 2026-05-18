const { drizzle } = require("drizzle-orm/node-postgres");
const { Pool } = require("pg");

const { env } = require("./env");

require("dotenv").config({ quiet: true });

if (!env.databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const pool = new Pool({
  connectionString: env.databaseUrl,
  idleTimeoutMillis: env.dbIdleTimeoutMs,
  max: env.dbPoolMax,
});
const vectorPool = new Pool({
  connectionString: process.env.VECTOR_DB_URL,
});

const db = drizzle(pool);

pool.on("error", (error) => {
  console.error("Unexpected database client error", error);
});

module.exports = { db, pool, vectorPool };
