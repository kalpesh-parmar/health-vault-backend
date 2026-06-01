const express = require("express");

const medicationController = require("../controllers/medicationController");
const { verifyToken } = require("../middlewares/authMiddleware");
const router = express.Router();

//create
router.post("/create", verifyToken, medicationController.createMedication);

//list of all data
router.get("/list", verifyToken, medicationController.getMedicationList);

//pagination list
router.post("/list-paginated", verifyToken, medicationController.listMedicationsPaginated);

//filter list
router.post("/list", verifyToken, medicationController.listMedications);

//get by id
router.get("/:id", verifyToken, medicationController.getMedicationById);

//updated user
router.put("/:id", verifyToken, medicationController.updateMedication);

//delted user
router.delete("/:id", verifyToken, medicationController.deleteMedication);

module.exports = router;
