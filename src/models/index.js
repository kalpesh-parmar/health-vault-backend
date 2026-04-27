// index.js

const { User } = require("./User");
const { session } = require("./session");
const { healthRecords } = require("./Health_Recode");
const { Document } = require("./Document");

// Export all tables in one place
module.exports = {
  User,
  session,
  healthRecords,
  Document,
};
