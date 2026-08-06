const { Storage } = require("@google-cloud/storage");

const { env } = require("./env");

function getCredentials() {
  if (!env.gcpCredentialsBase64) {
    return undefined;
  }
  return JSON.parse(Buffer.from(env.gcpCredentialsBase64, "base64").toString("utf8"));
}

const gcpStorage = new Storage({
  credentials: getCredentials(),
  projectId: env.gcpProjectId,
});

module.exports = { gcpStorage };
