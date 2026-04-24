const express = require("express");
const router = express.Router();
const patientController = require("../controllers/patientController");

router.post("/login", patientController.loginPatient);
router.post("/add", patientController.createPatient);
router.get("/list", patientController.getPatientList);
router.get("/:id", patientController.getPatientById);
router.put("/:id", patientController.updatePatient);
router.delete("/soft-delete/:id", patientController.deletePatient);
router.delete("/hard-delete/:id", patientController.permanentDeletePatient);
// logout patient
router.post("/logout", patientController.logout);
module.exports = router;
