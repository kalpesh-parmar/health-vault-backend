const express = require("express");
const patientController = require("../controllers/patient.controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const {
  profileUploadMulter,
  documentUploadMulter,
  validateProfileUpload,
  validateDocumentUpload,
} = require("../validations");

const router = express.Router();

router.get("/list", verifyToken, patientController.getPatientList);
router.get("/profile", verifyToken, patientController.getPatientProfile);
router.get("/:id", verifyToken, patientController.getPatientById);
router.put("/:id", verifyToken, patientController.updatePatient);
router.delete("/soft-delete/:id", verifyToken, patientController.deletePatient);
router.delete("/hard-delete/:id", verifyToken, patientController.permanentDeletePatient);

router.post(
  "/:patientId/profile/upload",
  verifyToken,
  profileUploadMulter,
  validateProfileUpload,
  patientController.uploadProfileImage,
);

router.post(
  "/:patientId/documents/upload",
  verifyToken,
  documentUploadMulter,
  validateDocumentUpload,
  patientController.uploadDocuments,
);

module.exports = router;
