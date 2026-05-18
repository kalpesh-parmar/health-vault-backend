const express = require("express");
const multer = require("multer");
const patientController = require("../controllers/patientController");
const { verifyToken } = require("../middlewares/authMiddleware");
const upload = multer({ dest: "uploads/" });
const router = express.Router();

router.post("/add", upload.single("profilePicture"), patientController.createPatient);
router.get("/list", verifyToken, patientController.getPatientList);
router.get("/profile", verifyToken, patientController.getPatientProfile);
router.get("/:id", verifyToken, patientController.getPatientById);
router.put("/:id", verifyToken, upload.single("profilePicture"), patientController.updatePatient);
router.delete("/soft-delete/:id", verifyToken, patientController.deletePatient);
router.delete("/hard-delete/:id", verifyToken, patientController.permanentDeletePatient);

module.exports = router;
