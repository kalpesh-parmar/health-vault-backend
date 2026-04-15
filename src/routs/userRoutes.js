const express = require("express");
const router = express.Router();
const userController = require("../controllers/userController");

router.post("/login", userController.loginUser);
router.post("/add",userController.createUser);
router.get("/:id",userController.getUserById);
// router.get("/list",userController.)
router.put("/:id",userController.updateUser);
router.delete("/:id",userController.deleteUser);


module.exports = router;