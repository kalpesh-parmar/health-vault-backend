const admin = require("firebase-admin");

async function getFirebaseUser(firebaseIdToken) {
  const decoded = await admin.auth().verifyIdToken(firebaseIdToken);

  return {
    firebaseUid: decoded.uid,
    provider: decoded.firebase.sign_in_provider,
    providerUserId: decoded.uid,

    email: decoded.email || null,
    emailVerified: decoded.email_verified || false,

    mobile: decoded.phone_number || null,

    firstName: decoded.name?.split(" ")[0] || "User",
    lastName: decoded.name?.split(" ").slice(1).join(" ") || "",
    fullName: decoded.name || null,

    avatarUrl: decoded.picture || null,
  };
}

module.exports = {
  getFirebaseUser,
};
