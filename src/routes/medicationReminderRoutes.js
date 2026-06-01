const express = require("express");
const router = express.Router();
const medicationReminderController = require("../controllers/medicationReminderController");
const { verifyToken } = require("../middlewares/authMiddleware");

// CREATE
router.post("/create", verifyToken, medicationReminderController.createReminder);

// GET ALL MAIN REMINDERS
router.get("/", verifyToken, medicationReminderController.getAllReminders);

// GET ALL OCCURRENCES
router.get("/occurrences", verifyToken, medicationReminderController.getAllOccurrences);

//get today occurrences
router.get("/occurrences/today", verifyToken, medicationReminderController.getTodayOccurrences);

// FILTER OCCURRENCES + PAGINATION
router.post("/occurrences/list", verifyToken, medicationReminderController.getOccurrences);

// UPDATE OCCURRENCE STATUS
router.patch("/occurrences/:id", verifyToken, medicationReminderController.updateOccurrence);

// DELETE MAIN REMINDER + OCCURRENCES
router.delete("/:id", verifyToken, medicationReminderController.deleteReminder);

module.exports = router;
