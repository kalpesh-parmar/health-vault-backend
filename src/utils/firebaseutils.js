const admin = require("firebase-admin");

async function verifyFirebaseToken(firebaseIdToken) {
  return await admin.auth().verifyIdToken(firebaseIdToken);
}

module.exports = {
  verifyFirebaseToken,
};
