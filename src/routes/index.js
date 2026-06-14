const express = require("express");
const { db } = require("../configs/db");
const { StatusCodes } = require("http-status-codes");

// Route imports
const authRoutes = require("./authRoutes");
const documentRoutes = require("./documentRoutes");
const notificationRoutes = require("./notificationRoutes");
const patientRoutes = require("./patientRoutes");
const sessionRoutes = require("./sessionRoutes");
const medicationRoutes = require("./medicationRoutes");
const medicationReminderRoutes = require("./medicationReminderRoutes");
const s3Routes = require("./s3Routes");
const cronRoutes = require("./cronRoutes");
const refillRoutes = require("./refillCountRoutes");
const chatSessionRoutes = require("./chatSessionRoutes");
const ocrHealthService = require("../services/aiService/ocr/ocrHealthService");

const router = express.Router();

// General Health Check
router.get("/health", async (_req, res) => {
  try {
    // Test database connection pool
    await db.execute("SELECT 1");
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

// OCR Health Check
router.get("/health/ocr", async (_req, res) => {
  try {
    const health = await ocrHealthService.check();
    const code = health.status === "ok" ? StatusCodes.OK : StatusCodes.SERVICE_UNAVAILABLE;
    res.status(code).json(health);
  } catch (error) {
    res.status(StatusCodes.SERVICE_UNAVAILABLE).json({
      status: "error",
      timestamp: new Date().toISOString(),
      error: error.message,
    });
  }
});

// Module Routes
router.use("/auth", authRoutes);
router.use("/documents", documentRoutes);
router.use("/notifications", notificationRoutes);
router.use("/session", sessionRoutes);
router.use("/patient", patientRoutes);
router.use("/medications", medicationRoutes);
router.use("/medication-reminders", medicationReminderRoutes);
router.use("/cron", cronRoutes);
router.use("/refill", refillRoutes);
router.use("/chat", chatSessionRoutes);
router.use("/s3-file-upload", s3Routes);

// Export router
module.exports = router;
