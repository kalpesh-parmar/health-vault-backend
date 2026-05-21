const express = require("express");

const documentRoutes = require("./documentRoutes");
const notificationRoutes = require("./notificationRoutes");
const patientRoutes = require("./patientRoutes");
const sessionRoutes = require("./sessionRoutes");
const authRoutes = require("./authRoutes");
const { messageConstants } = require("../constants/messageConstants");
const { successResponse } = require("../helpers/generalResponse");

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
router.use("/notifications", notificationRoutes);
router.use("/session", sessionRoutes);
router.use("/patient", patientRoutes);

module.exports = router;
