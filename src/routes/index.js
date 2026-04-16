const express = require("express");
const router = express.Router();

// import all route files
const sessionRoutes = require("./session");

// use routes
router.use("/session", sessionRoutes);

module.exports = router;
