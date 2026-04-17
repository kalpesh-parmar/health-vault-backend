const admin = require("firebase-admin");
require("dotenv").config();
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);

admin.initializeApp({
  credential: adminmin.credential.cert(serviceAccount),
});
export default admin;
