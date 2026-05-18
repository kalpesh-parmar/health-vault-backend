const { document } = require("./document");
const { notification } = require("./notification");
const { patient } = require("./patient");
const { session } = require("./session");
const { AIsummary } = require("./AIsummary");
const { medication } = require("./medication");

module.exports = {
  document,
  medication,
  notification,
  patient,
  session,
  AIsummary,
};
