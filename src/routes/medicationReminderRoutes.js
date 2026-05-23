const express = require("express");
const router = express.Router();
const medicationReminderController = require("../controllers/medicationReminderController.js");
const { verifyToken } = require("../middlewares/authMiddleware");


// CREATE REMINDER
router.post("/create", verifyToken, medicationReminderController.createReminder);
// GET TODAY OCCURRENCES
router.get("/occurrences/today", verifyToken, medicationReminderController.getTodayOccurrences);
// GET ALL REFILL ALERTS
router.get("/refill-alerts", verifyToken, medicationReminderController.getRefillAlerts);
// GET TODAY REFILL ALERTS
router.get("/refill-alerts/today", verifyToken, medicationReminderController.getTodayRefillAlerts);


// COMPLETE REMINDER
router.patch(
  "/occurrence/:id/complete",
  verifyToken,
  medicationReminderController.completeReminder,
);
// MISSED REMINDER
router.patch("/occurrence/:id/missed", verifyToken, medicationReminderController.missedReminder);
// SKIPPED REMINDER
router.patch("/occurrence/:id/skipped", verifyToken, medicationReminderController.skippedReminder);
// SNOOZE REMINDER
router.patch("/occurrence/:id/snooze", verifyToken, medicationReminderController.snoozeReminder);
// COMPLETE REFILL ALERT
router.patch(
  "/occurrence/:id/refill-completed",
  verifyToken,
  medicationReminderController.completeRefillAlert,
);
// SNOOZE REFILL ALERT
router.patch(
  "/occurrence/:id/refill-snooze",
  verifyToken,
  medicationReminderController.snoozeRefillAlert,
);
// GET ALL REMINDERS
router.get("/", verifyToken, medicationReminderController.getAllReminders);
// GET SINGLE REMINDER
router.get("/:id", verifyToken, medicationReminderController.getReminderById);
// SOFT DELETE REMINDER
router.delete("/:id", verifyToken, medicationReminderController.deleteReminder);

module.exports = router;
