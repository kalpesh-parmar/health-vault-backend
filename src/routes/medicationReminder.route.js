const express = require("express");
const router = express.Router();
const medicationReminderController = require("../controllers/medicationReminder.controller");
const medicationAdherenceController = require("../controllers/medicationAdherence.controller");
const { verifyToken } = require("../middlewares/authMiddleware");
const { validateRequest } = require("../middlewares/validateRequest");
const { createReminderSchema } = require("../validations");
const {
  weeklyDashboardQuerySchema,
  monthlyDashboardQuerySchema,
  dailyDetailsQuerySchema,
  refillsDashboardQuerySchema,
} = require("../validations");

// DASHBOARD ADHERENCE & REFILL INTELLIGENCE
router.get(
  "/dashboard/weekly",
  verifyToken,
  validateRequest({ query: weeklyDashboardQuerySchema }),
  medicationAdherenceController.getWeeklyAdherence,
);

router.get(
  "/dashboard/monthly",
  verifyToken,
  validateRequest({ query: monthlyDashboardQuerySchema }),
  medicationAdherenceController.getMonthlyAdherence,
);

router.get(
  "/dashboard/daily-details",
  verifyToken,
  validateRequest({ query: dailyDetailsQuerySchema }),
  medicationAdherenceController.getDailyDetails,
);

router.get(
  "/dashboard/refills",
  verifyToken,
  validateRequest({ query: refillsDashboardQuerySchema }),
  medicationAdherenceController.getRefillAlerts,
);

// CREATE
router.post(
  "/create",
  verifyToken,
  validateRequest({ body: createReminderSchema }),
  medicationReminderController.createReminder,
);

// GET ALL MAIN REMINDERS
router.get("/", verifyToken, medicationReminderController.getAllReminders);

// GET ALL OCCURRENCES
router.get("/occurrences", verifyToken, medicationReminderController.getAllOccurrences);

//get today occurrences
router.get("/occurrences/today", verifyToken, medicationReminderController.getTodayOccurrences);

//count api
router.post("/occurrences/summary", verifyToken, medicationReminderController.getMedicationSummary);

// FILTER OCCURRENCES + PAGINATION
router.post("/occurrences/list", verifyToken, medicationReminderController.getOccurrences);

// UPDATE OCCURRENCE STATUS
router.patch("/occurrences/:id", verifyToken, medicationReminderController.updateOccurrence);

// DELETE MAIN REMINDER + OCCURRENCES
router.delete("/:id", verifyToken, medicationReminderController.deleteReminder);

module.exports = router;
