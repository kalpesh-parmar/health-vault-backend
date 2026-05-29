const express = require("express");

const documentRoutes = require("./documentRoutes");
const notificationRoutes = require("./notificationRoutes");
const patientRoutes = require("./patientRoutes");
const sessionRoutes = require("./sessionRoutes");
const authRoutes = require("./authRoutes");
// const medicationRoutes = require("./medicationRoutes");
const medicationReminderRoutes = require("./medicationReminderRoutes");
// const { messageConstants } = require("../constants/messageConstants");
// const { successResponse } = require("../helpers/generalResponse");
const cronRoutes = require("./cronRoutes");
const { db } = require("../configs/db");
const { StatusCodes } = require("http-status-codes");

const router = express.Router();

router.get("/health", async (_req, res) => {
  try {
    // Test database connection
    await db.$client.query("SELECT 1");
    res.json({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: "connected",
    });
  } catch (error) {
    console.error("[health] Database connection failed:", error);
    res.status(StatusCodes.SERVICE_UNAVAILABLE).json({
      status: "error",
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      database: "disconnected",
    });
  }
});
router.use("/auth", authRoutes);
router.use("/documents", documentRoutes);
router.use("/notifications", notificationRoutes);
router.use("/session", sessionRoutes);
router.use("/patient", patientRoutes);
router.use("/medication-reminders", medicationReminderRoutes);
router.use("/cron", cronRoutes);
module.exports = router;
