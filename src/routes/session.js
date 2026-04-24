const express = require("express");
const router = express.Router();

const sessionController = require("../controllers/sessionController");

// create session
router.post("/", sessionController.createSession);

// get session by id
router.get("/:id", sessionController.getSessionById);


module.exports = router;
