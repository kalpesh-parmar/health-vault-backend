const express = require("express");
const router = express.Router();

// import all route files
const sessionRoutes = require("./session");
const userRoutes = require("./userRoutes");

// use routes
// router.use("/users",userRoutes);
router.use("/session", sessionRoutes);
router.use("/user", userRoutes);

module.exports = router;
