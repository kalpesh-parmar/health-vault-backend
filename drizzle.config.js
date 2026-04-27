require("dotenv").config();
console.log("DB URL:", process.env.DATABASE_URL);
const { defineConfig } = require("drizzle-kit");

module.exports = defineConfig({
  schema:[ "./src/models/index.js",
  "./src/enumData/*"],
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
