const { validate } = require("uuid");
const messageConstant = require("../constant/messageConstant");
const errorHandler = require("../excptions/globalHandling");
const GeneralResponse = require("../helpers/genralResponse");
const userService = require("../services/userService");
const zodValidateData=require("../validation/index");
const{  userSchema,
  loginUserSchema,
  updateUserSchema,
} = require("../validation/zodUserValidation");

class userController {
  // User Login
  loginUser = async (req, res, next) => {
    try {
      const result = await userService.loginUser(req?.body);
      return GeneralResponse.created(
        res,
        result,
        messageConstant.USER_LOGIN_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in login user:", error);
      next(error);
    }
  };
  // Create User
  createUser = async (req, res, next) => {
    try {
      const result = await userService.createUser(req?.body);
      return GeneralResponse.created(
        res,
        result,
        messageConstant.USER_ADDED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in create user:", error);
      next(error);
    }
  };

  // Get User by ID
  getUserById = async (req, res, next) => {
    try {
      const result = await userService.getUserById(req?.params?.id);
      return GeneralResponse.success(
        res,
        result,
        messageConstant.USER_FETCHED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in get user by id:", error);
      next(error);
    }
  };

  // Get User List
  getUserList = async (req, res, next) => {
    try {
      const result = await userService.getUserList();
      return GeneralResponse.success(
        res,
        result,
        messageConstant.USER_LIST_FETCHED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in get user list:", error);
      next(error);
    }
  };

  // Update User
  updateUser = async (req, res, next) => {
    try {
      const result = await userService.updateUser(req?.params?.id, req?.body);
      return GeneralResponse.updated(
        res,
        result,
        messageConstant.USER_UPDATED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in update user:", error);
      next(error);
    }
  };

  // Delete User
  deleteUser = async (req, res, next) => {
    try {
      const result = await userService.deleteUser(req?.params?.id);
      return GeneralResponse.success(
        res,
        result,
        messageConstant.USER_DELETED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in delete user:", error);
      next(error);
    }
  };
}
module.exports = new userController();
