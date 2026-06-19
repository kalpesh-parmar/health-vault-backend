const admin = require("firebase-admin");

const { env } = require("./env");

function getCredential() {
  const base64Creds = env.firebaseCredentialsBase64 || env.gcpCredentialsBase64;
  if (!base64Creds) {
    return null;
  }

  try {
    const credentialsJson = Buffer.from(base64Creds, "base64").toString("utf8");
    return admin.credential.cert(JSON.parse(credentialsJson));
  } catch (error) {
    console.error("Failed to parse Firebase/GCP credentials from base64:", error.message);
    return null;
  }
}

function initializeFirebase() {
  if (admin.apps.length > 0) {
    return admin.app();
  }

  const credential = getCredential();
  const projectId = env.firebaseProjectId || env.gcpProjectId;

  if (!credential) {
    console.warn("No Firebase credentials provided. Firebase Admin SDK will not be initialized.");
    return null;
  }

  return admin.initializeApp({
    credential,
    projectId,
  });
}

function getFirebaseMessaging() {
  const app = initializeFirebase();
  return app ? admin.messaging(app) : null;
}

async function verifyFirebaseToken(firebaseToken) {
  const app = initializeFirebase();
  if (!app) {
    throw new Error("Firebase Admin SDK is not initialized. Check credentials in env.");
  }

  // Verify ID Token and return decoded payload
  return admin.auth(app).verifyIdToken(firebaseToken);
}

module.exports = {
  getFirebaseMessaging,
  verifyFirebaseToken,
  initializeFirebase,
};
