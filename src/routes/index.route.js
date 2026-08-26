const express = require("express");
const { db } = require("../configs/db");
const { StatusCodes } = require("http-status-codes");

// Route imports
const authRoutes = require("./auth.route");
const documentRoutes = require("./document.route");
const notificationRoutes = require("./notification.route");
const patientRoutes = require("./patient.route");
const sessionRoutes = require("./session.route");
const medicationRoutes = require("./medication.route");
const medicationReminderRoutes = require("./medicationReminder.route");
const fileRoutes = require("./file.route");
const dashboardRoutes = require("./dashboard.route");
const cronRoutes = require("./cron.route");
const refillRoutes = require("./refillCount.route");
const chatSessionRoutes = require("./chatSession.route");
const { ocrService } = require("../services/ai");
const v1Routes = require("./ocr.route");
const sseRoutes = require("./sse.route");

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
    const health = await ocrService.checkHealth();
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
router.use("/dashboard", dashboardRoutes);
router.use("/file", fileRoutes);
router.use("/v1", v1Routes);
router.use("/sse", sseRoutes);

// Export router
module.exports = router;
