const { drizzle } = require("drizzle-orm/node-postgres");

require("dotenv").config();
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const db = drizzle(pool);
pool
  .connect()
  .then(() => console.log("database connect"))
  .catch((error) => console.log("error", error));

module.exports = { db, pool };