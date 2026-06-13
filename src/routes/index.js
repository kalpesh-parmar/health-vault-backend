const express = require("express");

const documentRoutes = require("./documentRoutes");
const notificationRoutes = require("./notificationRoutes");
const patientRoutes = require("./patientRoutes");
const sessionRoutes = require("./sessionRoutes");
const authRoutes = require("./authRoutes");
const medicationReminderRoutes = require("./medicationReminderRoutes");
const s3Routes = require("./s3Routes");
const cronRoutes = require("./cronRoutes");
const refill = require("./refillCountRoutes");
const medicationRoutes = require("./medicationRoutes");
const { db } = require("../configs/db");
const { StatusCodes } = require("http-status-codes");
const routes = express.Router();
const chatSessionRoutes = require("./chatSessionRoutes");
const ocrHealthService = require("../services/aiService/ocr/ocrHealthService");

routes.get("/health", async (_req, res) => {
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
routes.use("/auth", authRoutes);
routes.use("/patient", patientRoutes);
routes.use("/medications", medicationRoutes);
routes.use("/medication-reminders", medicationReminderRoutes);
routes.use("/documents", documentRoutes);
routes.use("/chat", chatSessionRoutes);
routes.use("/s3-file-upload", s3Routes);
routes.use("/notifications", notificationRoutes);
routes.use("/session", sessionRoutes);
routes.use("/cron", cronRoutes);
routes.use("/refill", refill);

routes.get("/health/ocr", async (_req, res) => {
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
module.exports = routes;
