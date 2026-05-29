const express = require("express");

const notificationController = require("../controllers/notificationController");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/test-send", verifyToken, notificationController.testSend);
router.post("/list", verifyToken, notificationController.list);
router.post("/list-paginated", verifyToken, notificationController.listPaginated);
router.put("/mark-read/:id", verifyToken, notificationController.markRead);
router.put("/mark-all-read", verifyToken, notificationController.markAllRead);
router.delete("/:id", verifyToken, notificationController.deleteNotification);
router.get("/badge-count", verifyToken, notificationController.badgeCount);

module.exports = router;
