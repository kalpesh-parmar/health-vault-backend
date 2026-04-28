const admin = require("firebase-admin");

const { env } = require("./env");

function getCredential() {
  if (!env.firebaseCredentialsBase64) {
    return null;
  }

  const credentialsJson = Buffer.from(env.firebaseCredentialsBase64, "base64").toString("utf8");
  return admin.credential.cert(JSON.parse(credentialsJson));
}

function initializeFirebase() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const credential = getCredential();

  if (!credential) {
    return null;
  }

  return admin.initializeApp({
    credential,
    projectId: env.firebaseProjectId,
  });
}

function getFirebaseMessaging() {
  const app = initializeFirebase();
  return app ? admin.messaging(app) : null;
}

module.exports = {
  getFirebaseMessaging,
};
