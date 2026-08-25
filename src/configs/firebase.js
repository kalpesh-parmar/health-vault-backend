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
  const decoded = await admin.auth(app).verifyIdToken(firebaseToken);
  console.log(
    "[FIREBASE SDK LOG] Decoded Firebase ID Token Payload:",
    JSON.stringify(decoded, null, 2),
  );
  return decoded;
}

async function findOrCreateFirebaseUser(email, name, providerUid) {
  const app = initializeFirebase();
  if (!app) {
    throw new Error("Firebase Admin SDK is not initialized. Check credentials in env.");
  }

  const auth = admin.auth(app);
  let userRecord = null;

  // 1. Try to find by custom uid (preferred to ensure consistency)
  const customUid = `microsoft_${providerUid}`;
  try {
    userRecord = await auth.getUser(customUid);
  } catch (error) {
    if (error.code !== "auth/user-not-found") {
      console.error("[FirebaseConfig] getUser failed:", error);
    }
  }

  // 2. Try to find by email if present and not found by UID
  if (!userRecord && email) {
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
    throw new Error("Firebase Admin SDK is not initialized. Check credentials in env.");
  }
  return admin.auth(app).createCustomToken(uid);
}

async function getFirebaseUser(uid) {
  const app = initializeFirebase();
  if (!app) return null;
  try {
    return await admin.auth(app).getUser(uid);
  } catch (error) {
    console.warn("[FirebaseConfig] getUser failed for uid:", uid, error.message);
    return null;
  }
}

module.exports = {
  getFirebaseMessaging,
  verifyFirebaseToken,
  initializeFirebase,
  findOrCreateFirebaseUser,
  createCustomFirebaseToken,
  getFirebaseUser,
};
