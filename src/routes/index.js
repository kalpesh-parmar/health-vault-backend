const express = require("express");

const documentRoutes = require("./document.route");
const notificationRoutes = require("./notificationRoutes");
const patientRoutes = require("./patient.route");
const sessionRoutes = require("./session.route");
const authRoutes = require("./auth.route");
const medicationReminderRoutes = require("./medication.route");
const s3Routes = require("./file.route");
const cronRoutes = require("./cron.route");
const refill = require("./refillCount.route");
const medicationRoutes = require("./medication.route");
const { db } = require("../configs/db");
const { StatusCodes } = require("http-status-codes");
const routes = express.Router();
const chatSessionRoutes = require("./chatSession.route");
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
routes.use("/file", s3Routes);
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
