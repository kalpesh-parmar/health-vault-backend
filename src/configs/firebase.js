const admin = require("firebase-admin");
const { env } = require("./env");
const { SocialMedia } = require("../enums/loginType.enum");
const { errorConstants } = require("../constants/errorConstants");

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

async function findOrCreateFirebaseUser(
  email,
  name,
  providerUid,
  provider = SocialMedia.MICROSOFT,
) {
  const app = initializeFirebase();
  if (!app) {
    throw new Error(errorConstants.FIREBASE_ADMIN_SDK_IS_NOT_INITIALIZED);
  }

  const auth = admin.auth(app);
  let userRecord = null;

  // Determine custom uid with provider prefix
  let customUid;
  if (providerUid.startsWith("microsoft_") || providerUid.startsWith("apple_")) {
    customUid = providerUid;
  } else {
    customUid = `${provider}_${providerUid}`;
  }

  // 1. Try to find by custom uid (preferred to ensure consistency)
  try {
    userRecord = await auth.getUser(customUid);
  } catch (error) {
    if (error.code !== "auth/user-not-found") {
      console.error("[FirebaseConfig] getUser failed:", error);
    }
  }

  // 2. Try to find by email if present and not found by UID (disabled for Apple to avoid account collision)
  if (!userRecord && email && provider !== SocialMedia.APPLE) {
    try {
      userRecord = await auth.getUserByEmail(email);
    } catch (error) {
      if (error.code !== "auth/user-not-found") {
        console.error("[FirebaseConfig] getUserByEmail failed:", error);
      }
    }
  }

  // 3. Create Firebase user if still not found
  if (!userRecord) {
    try {
      userRecord = await auth.createUser({
        uid: customUid,
        email: email || undefined,
        displayName: name || undefined,
        emailVerified: true,
      });
    } catch (error) {
      console.error("[FirebaseConfig] createUser failed:", error);
      throw error;
    }
  }

  return userRecord;
}

async function createCustomFirebaseToken(uid) {
  const app = initializeFirebase();
  if (!app) {
    throw new Error(errorConstants.FIREBASE_ADMIN_SDK_IS_NOT_INITIALIZED);
  }
  return admin.auth(app).createCustomToken(uid);
}

module.exports = {
  getFirebaseMessaging,
  verifyFirebaseToken,
  initializeFirebase,
  findOrCreateFirebaseUser,
  createCustomFirebaseToken,
};
