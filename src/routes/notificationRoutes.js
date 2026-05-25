const express = require("express");

const notificationController = require("../controllers/notificationController");
const { verifyToken } = require("../middlewares/authMiddleware");

const router = express.Router();

router.post("/test-send", verifyToken, notificationController.testSend);
router.post("/list", notificationController.list);
router.post("/list-paginated", notificationController.listPaginated);
router.put("/mark-read/:id", notificationController.markRead);
router.put("/mark-all-read", notificationController.markAllRead);
router.delete("/:id", notificationController.deleteNotification);
router.get("/badge-count", verifyToken, notificationController.badgeCount);

module.exports = router;
