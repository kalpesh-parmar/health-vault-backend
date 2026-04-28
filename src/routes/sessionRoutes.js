const express = require("express");

const sessionController = require("../controllers/sessionController");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/", verifyToken, sessionController.createSession);
router.get("/:id", verifyToken, sessionController.getSessionById);

module.exports = router;
