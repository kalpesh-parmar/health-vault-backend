const express = require("express");

const documentRoutes = require("./documentRoutes");
const notificationRoutes = require("./notificationRoutes");
const patientRoutes = require("./patientRoutes");
const sessionRoutes = require("./sessionRoutes");
const authRoutes = require("./authRoutes");
const chatSessionRoutes = require("./chatSessionRoutes");
const medicationRoutes = require("./medicationRoutes");
const s3Routes = require("./s3Routes");
const { db } = require("../configs/db");
const { StatusCodes } = require("http-status-codes");
const ocrHealthService = require("../services/aiService/ocr/ocrHealthService");

const router = express.Router();

router.get("/health", async (_req, res) => {
  try {
    // Test database connection
    await db.query("SELECT 1");
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
router.use("/auth", authRoutes);
router.use("/documents", documentRoutes);
router.use("/medications", medicationRoutes);
router.use("/notifications", notificationRoutes);
router.use("/session", sessionRoutes);
router.use("/s3-file-upload", s3Routes);
router.use("/patient", patientRoutes);
router.use("/chat", chatSessionRoutes);
module.exports = router;
