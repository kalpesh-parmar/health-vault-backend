//create a routes for cron want to create API for cron
const express = require("express");
const router = express.Router();
const cronController = require("../controllers/cronController");

router.post("/run-reminder", cronController.runReminder);
router.post("/start", cronController.cronStart);
router.post("/stop", cronController.cronStop);
router.post("/startAll", cronController.cronStartAll);
router.get("/list", cronController.cronList);

module.exports = router;
