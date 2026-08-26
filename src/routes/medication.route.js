const express = require("express");
const medicationController = require("../controllers/medication.controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const router = express.Router();

// check duplicate
router.post("/check-duplicate", verifyToken, medicationController.checkDuplicateMedication);

// create
router.post("/create", verifyToken, medicationController.createMedication);

// list of all data
router.get("/list", verifyToken, medicationController.getMedicationList);

// pagination list
router.post("/list-paginated", verifyToken, medicationController.listMedicationsPaginated);

// filter list
router.post("/list", verifyToken, medicationController.listMedications);

// refill medication
router.post("/refill/:id", verifyToken, medicationController.refillMedication);

// get by id
router.get("/:id", verifyToken, medicationController.getMedicationById);

// update
router.put("/:id", verifyToken, medicationController.updateMedication);

// delete
router.delete("/:id", verifyToken, medicationController.deleteMedication);

module.exports = router;
