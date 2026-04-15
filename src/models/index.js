// index.js

const { user } = require("./User");
const { session } = require("./session");
const { healthRecords } = require("./Health_Recode");
const { document } = require("./Document");

// Export all tables in one place
module.exports = {
  user,
  session,
  healthRecords,
  document,
};
