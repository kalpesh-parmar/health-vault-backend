const express = require("express");

const medicationController = require("../controllers/medicationController");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/create", verifyToken, medicationController.createMedication);

router.delete("/delete", verifyToken, medicationController.deleteMedication);
router.post("/list", verifyToken, medicationController.listMedication);
router.get("/list", verifyToken, medicationController.getMedicationlist);
router.get("/:id", verifyToken, medicationController.getMedicationById);
// router.delete("/:id", verifyToken, medicationController.deleteDocument);

module.exports = router;
