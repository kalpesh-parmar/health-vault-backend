const express = require("express");

const sessionController = require("../controllers/session.controller");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/", verifyToken, sessionController.createSession);
router.get("/:id", verifyToken, sessionController.getSessionById);

module.exports = router;
