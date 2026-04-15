require("dotenv").config();
console.log("DB URL:", process.env.DATABASE_URL);
const { defineConfig } = require("drizzle-kit");

console.log("CONFIG LOADED ✅");

module.exports = defineConfig({
  schema: "./src/models/User.js",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url: process.env.DATABASE_URL,
  },
});
