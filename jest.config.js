// Jest configuration for Health Vault backend
module.exports = {
  testEnvironment: "node",
  rootDir: ".",
  testMatch: ["**/tests/**/*.test.js", "**/tests/**/*.test.ts"],
  verbose: true,
  collectCoverage: false,
  setupFiles: ["<rootDir>/tests/setup.js"],
};
