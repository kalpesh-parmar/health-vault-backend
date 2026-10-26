const { db, pool } = require("../../src/configs/db");
const { sql } = require("drizzle-orm");

async function check() {
  try {
    const res = await db.execute(sql`SELECT current_database(), current_user, version()`);
    console.log("Database connection successful:", res.rows[0]);
    process.exit(0);
  } catch (err) {
    console.error("Database connection failed:", err.message);
    process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

check();
