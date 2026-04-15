// index.js

const { user } = require("./User");
const { session } = require("./Session");
const { healthRecords } = require("./HealthRecords");
const { document } = require("./Document");

// Export all tables in one place
module.exports = {
  user,
  session,
  healthRecords,
  document,
};
