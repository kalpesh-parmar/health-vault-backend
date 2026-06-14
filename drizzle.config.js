/**
 * Drizzle Kit config.
 *
 * `schema` globs every Drizzle table file under src/models so newly added
 * tables are picked up automatically. `out` keeps generated migrations in
 * the existing `drizzle/` folder used by the project (next to the runtime
 * SQL applied by `src/database/migrate.js`).
 */
const { defineConfig } = require("drizzle-kit");

require("dotenv").config({ quiet: true });

module.exports = defineConfig({
  schema: "./src/models/*.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
  strict: true,
  verbose: true,
});
