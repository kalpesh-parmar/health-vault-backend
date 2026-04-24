const { validate } = require("uuid");
const messageConstant = require("../constant/messageConstant");
const errorHandler = require("../excptions/globalHandling");
const GeneralResponse = require("../helpers/genralResponse");
const patientService = require("../services/patientService");
const zodValidateData = require("../validation/index");
const {
  userSchema,
  loginUserSchema,
  updateUserSchema,
} = require("../validation/zodUserValidation");
const { InvalidRequestException } = require("../excptions/ApiError");

class patientController {
  // Patient Login
  loginPatient = async (req, res, next) => {
    try {
      const result = await patientService.loginPatient(req?.body);
      return GeneralResponse.created(
        res,
        result,
        messageConstant.USER_LOGIN_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in login patient:", error);
      next(error);
    }
  };
  // Create Patient
  createPatient = async (req, res, next) => {
    try {
      const result = await patientService.createPatient(req?.body);
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

  // Get Patient by ID
  getPatientById = async (req, res, next) => {
    try {
      const result = await patientService.getPatientById(req?.params?.id);
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

  // Get Patient List
  getPatientList = async (req, res, next) => {
    try {
      const result = await patientService.getPatientList();
      return GeneralResponse.success(
        res,
        result,
        messageConstant.USERS_LIST_FETCHED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in get user list:", error);
      next(error);
    }
  };

  // Update Patient
  updatePatient = async (req, res, next) => {
    try {
      const result = await patientService.updatePatient(req?.params?.id, req?.body);
      return GeneralResponse.updated(
        res,
        result,
        messageConstant.USER_UPDATED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in update user :", error);
      next(error);
    }
  };

  // Delete Patient
  deletePatient = async (req, res, next) => {
    try {
      const result = await patientService.deletePatient(req?.params?.id);
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

  // Permanent Delete Patient
  permanentDeletePatient = async (req, res, next) => {
    try {
      const result = await patientService.permanentDeletePatient(req?.params?.id);
      return GeneralResponse.success(
        res,
        result,
        messageConstant.USER_PERMANENTLY_DELETED_SUCCESSFULLY,
      );
    } catch (error) {
      console.log("error in permanent delete patient:", error);
      next(error);
    }
  };
  // Logout Patient
  logout = async (req, res, next) => {
    try {
      const token = req.headers?.authorization.split(" ")[1];
      if (!token) {
        throw new InvalidRequestException(messageConstant.INVALID_TOKEN);
      }
      const result = await patientService.logout(token);
      return GeneralResponse.success(
        res,
        result,
        messageConstant.LOGOUT_SUCCESS,
      );
    } catch (error) {
      console.log("error in logout user:", error);
      next(error);
    }
  };
}
module.exports = new patientController();
