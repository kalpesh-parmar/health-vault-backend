const express = require("express");
const router = express.Router();
const patientController = require("../controllers/patient.controller");
const { verifyToken } = require("../middlewares/authMiddleware");

router.post("/social-login", patientController.socialLogin);
// router.post("/firebase-login", patientController.firebaseLogin);
router.post("/refresh-token", patientController.refreshToken);
router.post("/logout", verifyToken, patientController.logoutPatient);
router.post("/auth-failure", patientController.reportAuthFailure);

module.exports = router;
