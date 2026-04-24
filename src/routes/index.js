const express = require("express");
const router = express.Router();

// import all route files
const sessionRoutes = require("./session");
const patientRoutes = require("./patientRoutes");

// use routes
router.use("/session", sessionRoutes);
router.use("/patient", patientRoutes);

module.exports = router;
