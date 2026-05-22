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
