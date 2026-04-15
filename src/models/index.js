const { user } = require("./User");
const { document } = require("./Document");
const { healthRecords } = require("./Health_Recode");
const { roleEnum, ROLE } = require("../enum/roles");
const { genderEnum } = require("../enum/gender");

module.exports = {
  user,
  document,
  healthRecords,
  roleEnum,
  genderEnum,
};
