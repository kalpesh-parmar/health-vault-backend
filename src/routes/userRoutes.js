const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");
const { route } = require("./session");

router.post("/login", userController.loginUser);
router.post("/add", userController.createUser);
router.get("/list", userController.getUserList);
router.get("/:id", userController.getUserById);
router.put("/:id", userController.updateUser);
router.delete("/:id", userController.deleteUser);
router.delete("/permanentDelete/:id", userController.permanentDeleteUser);
module.exports = router;
