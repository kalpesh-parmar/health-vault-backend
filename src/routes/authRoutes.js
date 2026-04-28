const express = require("express");
const router = express.Router();
const patientController = require("../controllers/patientController");
const { verifyToken } = require("../middlewares/authMiddleware");

router.post("/login", patientController.loginPatient);
router.post("/refresh-token", patientController.refreshToken);
router.post("/request-otp", patientController.requestOtp);
router.post("/forgot-password", patientController.forgotPassword);
router.post("/verify-otp", patientController.verifyOtp);
router.post("/reset-password", patientController.resetPassword);
router.post("/logout", verifyToken, patientController.logoutPatient);

module.exports = router;
