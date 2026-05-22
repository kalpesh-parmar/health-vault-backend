const express = require("express");

const documentRoutes = require("./documentRoutes");
const notificationRoutes = require("./notificationRoutes");
const patientRoutes = require("./patientRoutes");
const sessionRoutes = require("./sessionRoutes");
const authRoutes = require("./authRoutes");
const chatbotRoutes = require("./chatbotApi.Routes");
const medicationRoutes = require("./medicationRoutes");
const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");
const s3Routes = require("./s3Routes");

const router = express.Router();

router.use("/health", (_req, res) =>
  successResponse(
    res,
    {
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
    },
    messageConstants.HEALTH_CHECK_SUCCESS,
  ),
);
router.use("/auth", authRoutes);
router.use("/documents", documentRoutes);
router.use("/medications", medicationRoutes);
router.use("/notifications", notificationRoutes);
router.use("/session", sessionRoutes);
router.use("/s3-file-upload", s3Routes);
router.use("/patient", patientRoutes);
router.use("/chatbot", chatbotRoutes);
module.exports = router;
